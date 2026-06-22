/* Dependency resolution — shared between the renderer (window.HMDeps) and tests (require).
   UMD wrapper: works as a browser global and as a CommonJS module. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HMDeps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Turn a component ON together with everything it (transitively) requires.
  function enableWithDeps(selected, byId, id) {
    if (!byId[id]) return;
    selected[id] = true;
    (byId[id].requires || []).forEach((r) => enableWithDeps(selected, byId, r));
  }

  // Turn a component OFF together with anything that (transitively) requires it.
  function disableDependents(selected, byId, id) {
    selected[id] = false;
    Object.keys(byId).forEach((cid) => {
      const c = byId[cid];
      if ((c.requires || []).includes(id) && selected[cid]) {
        disableDependents(selected, byId, cid);
      }
    });
  }

  // Topological order: a component's requirements always come before it.
  function installOrder(selected, byId) {
    const sel = new Set(Object.keys(selected).filter((id) => selected[id]));
    const ordered = [];
    const visiting = new Set();
    const visit = (id) => {
      if (!sel.has(id) || ordered.includes(id) || visiting.has(id)) return;
      visiting.add(id);
      (byId[id].requires || []).forEach(visit);
      visiting.delete(id);
      ordered.push(id);
    };
    sel.forEach(visit);
    return ordered;
  }

  return { enableWithDeps, disableDependents, installOrder };
});
