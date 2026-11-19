class SupabaseSync {
  constructor({ read, write, encrypt, decrypt, request = fetch, defaults = {} }) {
    Object.assign(this, { read, write, encrypt, decrypt, request });
    this.config = { ...defaults };
    this.session = null;
    this.refreshing = null;
  }
  async init() {
    const stored = await this.read();
    if (!stored) return;
    this.config = stored.config;
    if (stored.session) {
      try { this.session = JSON.parse(this.decrypt(stored.session)); }
      catch { throw new Error("无法解密同步登录信息，请在本机重新登录"); }
    }
  }
  connected() { return !!this.session; }
  publicConfig() { return { url: this.config.url || "", email: this.config.email || "", keyConfigured: !!this.config.key }; }
  async save() {
    await this.write({ config: this.config, session: this.session ? this.encrypt(JSON.stringify(this.session)) : null });
  }
  async rememberConnection({ url, key, email }) {
    if (this.session) return;
    const previousConfig = this.config;
    this.config = { ...previousConfig, url, key, ...(email === undefined ? {} : { email }) };
    try { await this.save(); }
    catch (error) { this.config = previousConfig; throw error; }
  }
  async call(route, payload, token) {
    let response;
    try {
      response = await this.request(`${this.config.url}${route}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", apikey: this.config.key, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload)
      });
    } catch { throw new Error("无法连接同步服务，修改已保留在本机，请检查网络后重试"); }
    if (!response.ok) {
      if (route.startsWith("/auth/v1/signup")) {
        if (response.status === 422 || response.status === 400) throw new Error("该邮箱已注册，或密码不符合要求（至少 6 位）。已注册请直接登录。");
        if (response.status === 429) throw new Error("注册请求过于频繁，请稍后再试。");
      }
      if (response.status === 400 && route.startsWith("/auth")) throw new Error("邮箱或密码不正确；新注册的账号需先到邮箱点击确认链接。");
      if ([401, 403].includes(response.status)) throw new Error("登录已过期或无访问权限，请重新登录");
      if (response.status === 404) throw new Error("未找到同步接口，请先执行数据库安装脚本");
      throw new Error(`同步服务请求失败（${response.status}），修改已保留，请重试或检查服务配置`);
    }
    return response.json();
  }
  connection(input = {}) {
    let url;
    try { url = new URL(String(input.url || this.config.url || "").trim()); } catch { throw new Error("请输入有效的 Supabase 项目地址"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("项目地址必须是 HTTPS 服务根地址，例如 https://abcd.supabase.co");
    const key = String(input.key || this.config.key || "").trim();
    if (!key || key.startsWith("sb_secret_")) throw new Error("请使用 Publishable key 或 anon key，不能使用服务端密钥");
    if (key.startsWith("eyJ")) {
      try {
        if (JSON.parse(Buffer.from(key.split(".")[1], "base64url")).role !== "anon") throw new Error();
      } catch { throw new Error("这里只接受 anon 公共密钥，不能使用服务端密钥"); }
    } else if (!key.startsWith("sb_publishable_")) throw new Error("请输入有效的 Publishable key 或 anon key");
    return { url: url.origin, key };
  }
  connectionCode() {
    if (!this.config.url || !this.config.key) throw new Error("本机还没有保存连接信息");
    return "xiaoye1:" + Buffer.from(JSON.stringify({ u: this.config.url, k: this.config.key })).toString("base64url");
  }
  async check(input) {
    const { url, key } = this.connection(input);
    let response;
    try {
      response = await this.request(`${url}/rest/v1/rpc/xiaoye_schema_info`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", apikey: key }, body: "{}" });
    } catch { throw new Error("无法连接该项目地址，请检查地址和网络"); }
    if ([401, 403].includes(response.status)) throw new Error("公共密钥不正确，请重新复制 Publishable key");
    if (response.status === 404) {
      await this.rememberConnection({ url, key });
      return { initialized: null };
    }
    if (!response.ok) throw new Error(`检查失败（${response.status}），请稍后重试`);
    const info = await response.json();
    await this.rememberConnection({ url, key });
    return { initialized: true, version: info?.version || 0, reminders: Boolean(info?.reminders) };
  }
  async register(input, bind) {
    if (this.session) throw new Error("请先退出当前同步账号，再注册新账号。");
    const previousConfig = this.config;
    const { url, key } = this.connection(input);
    const email = String(input.email || "").trim();
    this.config = { url, key, email };
    let result;
    try { result = await this.call("/auth/v1/signup", { email: this.config.email, password: input.password }); }
    finally { this.config = previousConfig; }
    if (result?.access_token) return this.login(input, bind, result);
    await this.rememberConnection({ url, key, email });
    return { confirmEmail: true };
  }
  async login(input, bind, existingSession = null) {
    const { url: origin, key } = this.connection(input);
    const url = new URL(origin);
    const previousConfig = this.config, previousSession = this.session;
    this.config = { url: url.origin, key, email: String(input.email || "").trim() };
    try {
      const session = existingSession || await this.call("/auth/v1/token?grant_type=password", { email: this.config.email, password: input.password });
      if (!session.user?.id || !session.access_token || !session.refresh_token) throw new Error("登录服务返回无效会话");
      await bind(`${url.origin}|${session.user.id}`);
      this.session = session;
      await this.save();
    } catch (error) {
      this.config = previousConfig;
      this.session = previousSession;
      throw error;
    }
  }
  async logout() { this.session = null; await this.save(); }
  async exchange(ops) {
    return this.authorizedCall("/rest/v1/rpc/xiaoye_sync_v2", { operations: ops });
  }
  async backupCall(action, args) {
    return this.authorizedCall("/rest/v1/rpc/xiaoye_device_backup", { action, args });
  }
  async authorizedCall(route, payload) {
    if (!this.session) throw new Error("请先登录同步账号");
    if (!this.session.expires_at || this.session.expires_at * 1000 < Date.now() + 60000) {
      if (!this.refreshing) this.refreshing = (async () => {
        const previous = this.session;
        const next = await this.call("/auth/v1/token?grant_type=refresh_token", { refresh_token: previous.refresh_token });
        if (this.session !== previous) throw new Error("登录状态已变更，请重试");
        if (next.user?.id !== previous.user.id || !next.access_token || !next.refresh_token) throw new Error("刷新会话身份不匹配，请重新登录");
        this.session = next;
        await this.save();
      })();
      const refresh = this.refreshing;
      try { await refresh; }
      finally { if (this.refreshing === refresh) this.refreshing = null; }
    }
    return this.call(route, payload, this.session.access_token);
  }
}
module.exports = { SupabaseSync };
