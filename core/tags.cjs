// Tags service — Phase 5 partial.
//
// Cross-cutting metadata keyed by `<type>:<id>` (the stableKey scheme).
// Tags are ARRAYS of strings deduplicated on write. Backed by CONFIG.tags
// for persistence — this module owns the read/write contract and lets
// adapters skip touching CONFIG.tags directly.
//
// Why a service, not an adapter:
//   - Tags don't have their own lifecycle; they piggyback on items from
//     other adapters.
//   - Keying tags by stableKey crosses adapter boundaries — making tags
//     itself an adapter would require the tags adapter to know every
//     other adapter's stableId scheme. Reviewer 2 flagged this as a
//     circular shape during M4 plan synthesis.
//
// Factory pattern matches adapters/ — server.cjs constructs with
// {getConfig, saveConfig} so the tags service can be unit-tested with
// in-memory mocks.

module.exports = function createTagsService(deps) {
  const { getConfig, saveConfig } = deps;

  function ensureMap() {
    const cfg = getConfig();
    if (!cfg.tags) cfg.tags = {};
    return cfg.tags;
  }

  function stableKey(type, id) {
    // id may already be prefixed (e.g. 'pm2:foo' from adapter.list output)
    // OR be the bare id (when called from /api/tags/:type/:key route).
    // Normalize: strip any existing `<type>:` prefix.
    const bare = id.startsWith(`${type}:`) ? id.slice(type.length + 1) : id;
    return `${type}:${bare}`;
  }

  return {
    stableKey,

    getAll() {
      return { ...ensureMap() };
    },

    getTagsFor(type, id) {
      const sk = stableKey(type, id);
      return [...(ensureMap()[sk] || [])];
    },

    setTagsFor(type, id, tags) {
      const sk = stableKey(type, id);
      const map = ensureMap();
      const cleaned = (Array.isArray(tags) ? tags : [])
        .map((t) => String(t).trim())
        .filter(Boolean);
      const deduped = [...new Set(cleaned)];
      if (deduped.length === 0) delete map[sk];
      else map[sk] = deduped;
      saveConfig();
      return deduped;
    },

    addTag(type, id, tag) {
      const current = this.getTagsFor(type, id);
      if (!current.includes(tag)) current.push(tag);
      return this.setTagsFor(type, id, current);
    },

    removeTag(type, id, tag) {
      const current = this.getTagsFor(type, id).filter((t) => t !== tag);
      return this.setTagsFor(type, id, current);
    },

    clearTagsFor(type, id) {
      const sk = stableKey(type, id);
      const map = ensureMap();
      delete map[sk];
      saveConfig();
    },
  };
};
