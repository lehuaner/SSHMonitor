#!/data/data/com.termux/files/usr/bin/bash
SUB_URL='https://study.small1999.sbs/study/xuexi/v999/hneko?token=48e0f169a5aa41357aeb3352ced45ee8'
CFG=$HOME/sb-config.json
log(){ echo "[$(date '+%H:%M:%S')] $*";}
curl -sL "$SUB_URL" -o $HOME/sub.enc || { log "ERROR: download fail"; exit 1; }
raw=$(base64 -d $HOME/sub.enc 2>/dev/null) || { log "ERROR: decode fail"; exit 1; }
rm -f $HOME/sub.enc
line=$(echo "$raw" | grep '^hysteria2' | grep -vi 'ipv6' | grep '%E6%97%A5%E6%9C%AC' | head -1)
[ -z "$line" ] && line=$(echo "$raw" | grep '^hysteria2' | grep -vi 'ipv6' | head -1)
[ -z "$line" ] && log "ERROR: no node" && exit 1
s=${line#hysteria2://}
pw=${s%%@*}
r=${s#*@}
hp="${r%%[?#]*}"
srv=${hp%:*}
prt=${hp#*:}
prt=${prt%/}
log "Node: $srv:$prt"
cat > "$CFG" << JSON
{"log":{"level":"info"},"dns":{"servers":[{"tag":"dns","address":"https://1.12.12.12/dns-query","detour":"direct"},{"tag":"local","address":"223.5.5.5"}],"rules":[{"domain_suffix":[".nekohub.xyz",".google.com",".openai.com","chatgpt.com"],"server":"dns"}],"final":"local"},"inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":7897}],"outbounds":[{"type":"hysteria2","tag":"japan","server":"$srv","server_port":$prt,"password":"$pw","tls":{"enabled":true,"server_name":"www.bing.com","insecure":true}},{"type":"direct","tag":"direct"}],"route":{"rules":[{"outbound":"direct","domain_suffix":["localhost",".local"]}],"final":"japan","auto_detect_interface":true},"experimental":{"clash_api":{"external_controller":"127.0.0.1:9090","secret":""}}}
JSON
pkill -f 'sing-box run' 2>/dev/null; sleep 1
ENABLE_DEPRECATED_LEGACY_DNS_SERVERS=true ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER=true setsid sing-box run -c "$CFG" &>/dev/null & disown
log "OK: $srv:$prt"
