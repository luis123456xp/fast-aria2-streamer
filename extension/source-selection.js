(function (root) {
  function isRule34VideoHost(hostname) {
    return /(^|\.)rule34video\.com$/i.test(String(hostname || ''));
  }

  function getRule34QualitySources(entries, pageHostname, pageHref) {
    if (!isRule34VideoHost(pageHostname)) return [];

    const sources = [];
    for (const entry of entries || []) {
      const match = String(entry?.text || '').match(/\bMP4\s+(\d{3,4})p\b/i);
      if (!match) continue;
      try {
        const url = new URL(entry.href, pageHref);
        if (!isRule34VideoHost(url.hostname) || !/\.mp4(?:\/|$)/i.test(url.pathname)) continue;
        sources.push({ url: url.href, height: Number.parseInt(match[1], 10) });
      } catch {}
    }

    return sources
      .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
      .sort((a, b) => b.height - a.height);
  }

  const api = { getRule34QualitySources, isRule34VideoHost };
  root.Aria2SourceSelection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
