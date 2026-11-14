# AelionBot 中继

手机访问电脑上的 AelionBot 时，手机和电脑都主动连到中继，中继按“房间”把它们配对并转发数据。所以电脑不需要公网 IP，也不用做端口映射，手机在 4G 或别的 Wi‑Fi 下都能连。

中继只转发端到端加密后的字节。它没有密钥，看不到消息、文件、审批、Bot 名称和设备名称，也不保存任何内容。它能看到的只有：房间号（由电脑公钥算出，不对应账号）、双方 IP、连接时间和流量大小。

中继同时提供手机网页（PWA），自己部署时只需要一台服务器。官方实例是 `https://relay.aelion.chat`（中继）和 `https://app.aelion.chat`（手机网页）。

## 构建

```sh
pnpm install --frozen-lockfile
pnpm run relay:build
```

产物在 `relay/dist/`，就是完整的部署包：

- `relay.cjs`：中继本体，单文件，只依赖 Node.js 20 以上
- `public/`：手机网页
- `deploy/install.sh`：安装脚本

本机试运行：`pnpm run relay`，然后打开 <http://127.0.0.1:8790>。只有 `localhost` 和 HTTPS 页面能用 WebCrypto，所以在手机上测试必须走 HTTPS。

## 部署（Ubuntu 22.04+ / Debian 12+）

1. 准备一台服务器，开放 TCP 80、443 和 UDP 3478。1 核 1 GB 就够，主要花费在流量上。
2. 把域名（例如 `relay.example.com`）解析到服务器。
3. 上传并安装：

```sh
scp -r relay/dist root@服务器:/tmp/aelion-relay
ssh root@服务器 'bash /tmp/aelion-relay/deploy/install.sh relay relay.example.com'
```

脚本会安装这些东西：

- Node.js 24、Caddy（自动申请 HTTPS 证书）、coturn
- 中继：systemd 服务 `aelion-relay`，只监听 `127.0.0.1:8790`，由 Caddy 反向代理
- coturn 只做 STUN（不中转数据），帮手机和电脑找到直连路径

4. 在电脑上打开“设置 → 手机访问 → 中继”，中继地址填 `https://relay.example.com`，手机网页地址留空（留空就由中继提供网页）。

更新时重复第 3 步即可。已配对的手机不受影响，但换了中继地址就要重新配对。

### 把手机网页放到另一台服务器

如果想让网页离用户近一些、单独做 CDN，可以分开部署：

```sh
ssh root@网页服务器 'bash /tmp/aelion-relay/deploy/install.sh app app.example.com wss://relay.example.com'
```

然后在电脑上把“手机网页地址”填成 `https://app.example.com`。网页的 CSP 只允许连接这个中继。

## 运维

- 日志：`journalctl -u aelion-relay -f`。中继只记录启动信息，不记录房间号和内容。
- 健康检查：`curl http://127.0.0.1:8790/healthz`，返回当前在线的电脑数和手机数。
- 限额：在 `/etc/systemd/system/aelion-relay.service` 里修改环境变量后运行 `systemctl restart aelion-relay`。
  - `RELAY_DAILY_GB`：每个房间每天转发的流量上限，默认 4 GB，`0` 表示不限
  - `RELAY_PORT`、`RELAY_HOST`：监听地址
  - `RELAY_TRUST_PROXY=1`：从反向代理的 `X-Forwarded-For` 读取客户端 IP，用于按 IP 限制连接数
- 其他固定限制：每个房间最多同时连 8 部手机；单帧最大 512 KB；每个 IP 最多 40 个连接。

## 协议

- 电脑连 `wss://域名/v1/desktop`，用签名密钥对中继给的随机数签名，证明自己拥有对应的房间。房间号 = SHA-256(签名公钥) 的前 24 字节。
- 手机连 `wss://域名/v1/client?room=房间号`。电脑不在线时，中继会告诉手机，并保持连接；电脑上线后再通知手机。
- 握手、加密和消息格式见 `shared/remote/`，设计说明见 `docs/design/Mobile-Remote-20261114.md`。
