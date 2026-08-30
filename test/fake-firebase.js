/* =====================================================================
   fake-firebase.js  — an in-memory stand-in for the Firebase Realtime
   Database compat SDK, good enough for the parts ff-draft-kit uses:

     firebase.initializeApp(cfg)
     firebase.database()
     db.ref(key).once('value')      -> snapshot.val()
     db.ref(key).set(value)
     db.ref(key).on('value', cb, errCb)
     db.ref(key).transaction(fn, onComplete, applyLocally)
     db.ref(key).push(obj)
     db.ref(key).limitToLast(n).on('value', cb)

   It lives on the HARNESS page. Every simulated device (an iframe) talks to
   this one shared server, so we get real cross-device behaviour on a single
   JS thread — including genuine write races.

   Every read, write and broadcast is delayed by `latencyMs` and counted, so
   the harness can report exactly how many bytes each pick costs.
===================================================================== */
(function (global) {
  function makeServer(opts) {
    opts = opts || {};
    const latency = opts.latencyMs == null ? 40 : opts.latencyMs;
    const jitter = opts.jitterMs == null ? 15 : opts.jitterMs;

    const store = new Map();            // key -> value (string or object)
    const listeners = new Map();        // key -> Set<{cb, limit}>
    const stats = {
      writes: 0,
      bytesWritten: 0,
      broadcasts: 0,
      bytesBroadcast: 0,
      reads: 0,
      bytesRead: 0,
      transactionRetries: 0,
      abortedTransactions: 0,
      perKey: {},
    };

    function bump(key, field, n) {
      const k = (stats.perKey[key] = stats.perKey[key] || {
        writes: 0, bytesWritten: 0, broadcasts: 0, bytesBroadcast: 0, reads: 0, bytesRead: 0,
      });
      k[field] += n;
    }

    const sizeOf = (v) => (v == null ? 0 : (typeof v === 'string' ? v.length : JSON.stringify(v).length));
    const wire = () => latency + Math.random() * jitter;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function snapshotFor(value) {
      return { val: () => (value === undefined ? null : value), exists: () => value != null };
    }

    function broadcast(key) {
      const set = listeners.get(key);
      if (!set || !set.size) return;
      const value = store.get(key);
      for (const l of set) {
        const payload = l.limit ? applyLimit(value, l.limit) : value;
        const bytes = sizeOf(payload);
        stats.broadcasts++; stats.bytesBroadcast += bytes;
        bump(key, 'broadcasts', 1); bump(key, 'bytesBroadcast', bytes);
        setTimeout(() => { try { l.cb(snapshotFor(payload)); } catch (e) { console.error('listener threw', e); } }, wire());
      }
    }

    function applyLimit(value, n) {
      if (!value || typeof value !== 'object') return value;
      const keys = Object.keys(value).sort();
      const keep = keys.slice(-n);
      const out = {};
      keep.forEach((k) => { out[k] = value[k]; });
      return out;
    }

    function ref(key, limit) {
      return {
        async once() {
          await sleep(wire());
          const v = store.get(key);
          const bytes = sizeOf(v);
          stats.reads++; stats.bytesRead += bytes;
          bump(key, 'reads', 1); bump(key, 'bytesRead', bytes);
          return snapshotFor(limit ? applyLimit(v, limit) : v);
        },

        async set(value) {
          await sleep(wire());
          const bytes = sizeOf(value);
          stats.writes++; stats.bytesWritten += bytes;
          bump(key, 'writes', 1); bump(key, 'bytesWritten', bytes);
          store.set(key, value);
          broadcast(key);
        },

        /* Emulates RTDB's optimistic compare-and-set: run the updater against
           the value we believe is current; if the server moved underneath us,
           re-run against the new value. */
        async transaction(updater, onComplete, _applyLocally) {
          let attempts = 0;
          while (true) {
            attempts++;
            await sleep(wire());                 // fetch current
            const current = store.get(key);
            let next;
            try { next = updater(current === undefined ? null : current); }
            catch (e) {
              stats.abortedTransactions++;
              if (onComplete) onComplete(e, false, snapshotFor(current));
              return { committed: false, snapshot: snapshotFor(current) };
            }

            if (next === undefined) {            // updater aborted
              stats.abortedTransactions++;
              if (onComplete) onComplete(null, false, snapshotFor(current));
              return { committed: false, snapshot: snapshotFor(current) };
            }

            await sleep(wire());                 // send compare-and-set
            if (store.get(key) !== current) {    // someone beat us — retry
              stats.transactionRetries++;
              if (attempts > 25) {
                if (onComplete) onComplete(new Error('maxretry'), false, snapshotFor(store.get(key)));
                return { committed: false, snapshot: snapshotFor(store.get(key)) };
              }
              continue;
            }

            const bytes = sizeOf(next);
            stats.writes++; stats.bytesWritten += bytes;
            bump(key, 'writes', 1); bump(key, 'bytesWritten', bytes);
            store.set(key, next);
            broadcast(key);
            if (onComplete) onComplete(null, true, snapshotFor(next));
            return { committed: true, snapshot: snapshotFor(next) };
          }
        },

        on(evt, cb, errCb) {
          const entry = { cb, limit };
          if (!listeners.has(key)) listeners.set(key, new Set());
          listeners.get(key).add(entry);
          const v = store.get(key);
          if (v !== undefined) {
            const payload = limit ? applyLimit(v, limit) : v;
            setTimeout(() => cb(snapshotFor(payload)), wire());
          }
          return cb;
        },

        off() { listeners.delete(key); },

        push(obj) {
          const cur = store.get(key) || {};
          const id = '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          cur[id] = obj;
          store.set(key, cur);
          setTimeout(() => broadcast(key), wire());
          return { key: id };
        },

        limitToLast(n) { return ref(key, n); },
      };
    }

    /* Minimal stand-in for firebase.auth(). index.html calls
       signInAnonymously() on startup and gates every DB call on it resolving;
       the harness has no real auth, so hand back a token immediately. */
    const fakeAuth = {
      currentUser: { uid: 'fake-anon-uid', isAnonymous: true },
      signInAnonymously() {
        return Promise.resolve({ user: fakeAuth.currentUser });
      },
      onAuthStateChanged(cb) {
        setTimeout(() => cb(fakeAuth.currentUser), 0);
        return () => {};
      },
    };

    return {
      stats,
      reset() {
        stats.writes = stats.bytesWritten = stats.broadcasts = stats.bytesBroadcast = 0;
        stats.reads = stats.bytesRead = stats.transactionRetries = stats.abortedTransactions = 0;
        stats.perKey = {};
      },
      seed(key, value) { store.set(key, value); },
      peek(key) { return store.get(key); },
      /* the object each iframe sees as `firebase` */
      sdk: {
        initializeApp() { return {}; },
        database() { return { ref }; },
        auth() { return fakeAuth; },
      },
    };
  }

  global.makeFakeFirebase = makeServer;
})(typeof window !== 'undefined' ? window : globalThis);
