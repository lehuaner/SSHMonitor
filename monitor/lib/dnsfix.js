// lib/dnsfix.js — Termux 守护进程 DNS 兜底
//
// 现象：runit 起的后台进程（mon-release/checkin/gateway）调用系统 getaddrinfo 偶发 ENOTFOUND；
//       公共 DNS 的 UDP:53 出站在本设备也时好时坏。任一路单独用都会偶发失败。
// 处理：注入 undici Agent 的自定义 lookup —— 先试系统 getaddrinfo（多数时候可用），
//       失败再退回公共 DNS（AliDNS/Google/Cloudflare）解析。两路互备，最大化成功率；
//       keepAlive 调短规避坏连接复用。fetchWithRetry 再对整体请求做退避重试。
// 用法：进程入口 import { installPublicDns } from './lib/dnsfix.js'; installPublicDns();（幂等，只装一次）
import { setGlobalDispatcher, Agent } from 'undici';
import dns from 'node:dns';

let installed = false;

export function installPublicDns(servers = ['223.5.5.5', '8.8.8.8', '1.1.1.1']) {
  if (installed) return;
  installed = true;

  let resolver = null;
  try {
    resolver = new dns.Resolver();
    resolver.setServers(servers);
    resolver.setMinutesCache?.(1);
  } catch { resolver = null; }

  const systemLookup = dns.lookup; // 保留系统 getaddrinfo 作首路

  const viaPublic = (hostname, options, cb) => {
    if (!resolver) return cb(new Error(`dns unavailable for ${hostname}`));
    const all = options && options.all;
    resolver.resolve4(hostname, (e4, v4) => {
      if (!e4 && v4 && v4.length) {
        return cb(null, all ? v4.map((address) => ({ address, family: 4 })) : v4[0], all ? undefined : 4);
      }
      resolver.resolve6(hostname, (e6, v6) => {
        if (!e6 && v6 && v6.length) {
          return cb(null, all ? v6.map((address) => ({ address, family: 6 })) : v6[0], all ? undefined : 6);
        }
        return cb(e4 || e6 || new Error(`public dns failed for ${hostname}`));
      });
    });
  };

  const lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    // 已是 IP 直接返回
    systemLookup(hostname, { ...options, verbatim: true }, (err, address, family) => {
      if (!err && address) return cb(null, address, family);
      viaPublic(hostname, options, (err2, address2, family2) => {
        if (!err2 && address2) return cb(null, address2, family2);
        return cb(err || err2 || new Error(`dns failed for ${hostname}`));
      });
    });
  };

  try {
    setGlobalDispatcher(new Agent({
      connect: { lookup, noDelay: true, keepAlive: true },
      keepAliveTimeout: 4000,
      keepAliveMaxTimeout: 10000,
      connections: 16,
    }));
  } catch (e) {
    console.error(`[dnsfix] 安装失败（退回系统解析）: ${e.message}`);
  }
}
