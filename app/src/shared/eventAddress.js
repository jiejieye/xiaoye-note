(function (root) {
  function webUrl(value) {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return "";
    const text = value.trim().replace(/^www\./i, "https://www.");
    if (!/^https?:\/\//i.test(text)) return "";
    try {
      const url = new URL(text);
      return url.hostname && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }

  function parse({ text = "", uri = "", url = "", title = "", location = "" } = {}) {
    text = String(text).trim();
    const match = text.match(/(?:https?:\/\/|www\.)[^\s<>"'，。；]+/i);
    const linkedText = match?.[0].replace(/[，。；！？,;!]+$/, "") || "";
    const address = webUrl(url) || uri.split(/\r?\n/).filter(line => !line.startsWith("#")).map(webUrl).find(Boolean) || webUrl(linkedText);
    if (!address && (url || uri.trim()) && !location) return null;
    if (!address && /(?:^[a-z][\w+.-]*:|<\/?[a-z])/i.test(text)) return null;
    const remainder = text.replace(match?.[0] || "", "").replace(/^(?:链接|网址)[:：]\s*/m, "").trim();
    const place = String(location || text.match(/(?:地址|地点|位置)[:：]\s*([^\n]+)/)?.[1] || (!address ? text.replace(/^(?:\[位置\]|【位置】)\s*/, "") : "")).trim();
    if (!address && !place) return null;
    const name = String(title || remainder.split(/\r?\n/).find(line => line.trim()) || place || (new URL(address).hostname === "mp.weixin.qq.com" ? "微信文章" : "网页链接")).trim();
    return { title: name.slice(0, 120), url: address || "", location: place, note: text && text !== name ? text : "" };
  }

  const api = { webUrl, parse };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EventAddress = api;
})(typeof window === "object" ? window : globalThis);
