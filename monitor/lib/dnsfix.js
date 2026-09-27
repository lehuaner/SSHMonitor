// lib/dnsfix.js — Termux 守护进程 DNS 兜底
//
// 现象：runit 起的后台进程（mon-release/checkin/gateway）调用系统 getaddrinfo 常报 ENOTFOUND，
//       但出站 IP 连通正常（交互会话有 DNS 所以手测能过）。这是 Termux 脱离会话的守护进程 DNS 桩失效。
// 处理：用 undici Agent 注入自定义 lookup，改走公共 DNS（AliDNS/Google/Cloudflare）解析 IPv4，
//       覆盖全局 fetch 的连接；同时把 keepAlive 调短，规避坏 keep-alive 套接字复用导致的偶发 fetch failed。
// 用法：进程入口 import { installPublicDns } from './lib/dnsfix.js'; installPublicDns();（幂等，只装一次）
import { setGlobalDispatcher, Agent } from 'undici';
import { Resolver } from 'node:dns';

let installed = false;

export function installPublicDns(servers = ['223.5.5.5', '8.8.8.8', '1.1.1.1']) {
  if (installed) return;
  installed = true;
  let resolver;
  try {
    resolver = new Resolver();
    resolver.setServers(servers);
    resolver.setMinutesCache?.(1);
  } catch { return; }

  const lookup = (hostname, options, cb) => {
    const all = options && options.all;
    resolver.resolve4(hostname, (e4, v4) => {
      if (!e4 && v4 && v4.length) {
        return cb(null, all ? v4.map((address) => ({ address, family: 4 })) : v4[0], all ? undefined : 4);
      }
      resolver.resolve6(hostname, (e6, v6) => {
        if (!e6 && v6 && v6.length) {
          return cb(null, all ? v6.map((address) => ({ address, family: 6 })) : v6[0], all ? undefined : 6);
        }
        return cb(e4 || e6 || new Error(`dns resolve failed for ${hostname}`));
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
