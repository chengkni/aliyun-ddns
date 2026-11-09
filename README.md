# aliyun-ddns

用阿里云 DNS OpenAPI 维护一组 **A / AAAA** 记录的 DDNS。镜像由 GitHub Actions 构建并推送到 GHCR，使用方只负责 `pull`。

- 官方 `@alicloud/alidns20150109` v2 SDK
- IPv4 始终维护，IPv6 可选（`ENABLE_IPV6`，默认关闭）
- 只更新 `SUBDOMAINS` 里列出的 RR
- 拒绝把私网、回环、链路本地、ULA、CGNAT 地址写入 DNS
- `DRY_RUN=1` 只查询不写入；`RUN_ONCE=1` 跑一轮退出
- 容器非 root、只读文件系统、`cap_drop: ALL`，不监听任何端口

## 镜像

```
ghcr.io/chengkni/aliyun-ddns:ddns-2.1.0   # 版本标签
ghcr.io/chengkni/aliyun-ddns:latest       # 默认分支最新
ghcr.io/chengkni/aliyun-ddns:fp-<指纹>    # 不可变，按构建输入定位
ghcr.io/chengkni/aliyun-ddns:sha-<提交>   # 对应提交
```

公开镜像，`docker pull` 不需要登录 GitHub。

> `latest` **不会自动更新**，仍然要显式 `docker compose pull`。想要每次启动都拉最新，再加 `pull_policy: always`——代价是某次重启后行为可能和之前不同。
> 需要完全可复现时用 `fp-<指纹>` 或 `sha-<提交>`。

## 运行

本仓库只产出镜像；部署用的 compose、`.env` 和站点配置在外部的部署目录中。

最小示例：

```bash
docker run -d --name aliyun-ddns \
  --restart unless-stopped \
  --network host \
  --read-only \
  --user 65534:65534 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -e TZ=Asia/Shanghai \
  -e ALIYUN_ACCESS_KEY_ID=<...> \
  -e ALIYUN_ACCESS_KEY_SECRET=<...> \
  -e DOMAIN=example.com \
  -e SUBDOMAINS=llm,home,api \
  ghcr.io/chengkni/aliyun-ddns:ddns-2.1.0
```

首次部署建议先用只读模式验证 AK 权限：

```bash
docker run --rm --network host \
  -e ALIYUN_ACCESS_KEY_ID=<...> \
  -e ALIYUN_ACCESS_KEY_SECRET=<...> \
  -e DOMAIN=example.com \
  -e SUBDOMAINS=llm \
  -e DRY_RUN=1 -e RUN_ONCE=1 \
  ghcr.io/chengkni/aliyun-ddns:ddns-2.1.0
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `TZ` | 否 | `Asia/Shanghai` | 日志时区 |
| `ALIYUN_ACCESS_KEY_ID` | 是 | — | RAM 子账号 AccessKeyId |
| `ALIYUN_ACCESS_KEY_SECRET` | 是 | — | RAM 子账号 AccessKeySecret |
| `DOMAIN` | 是 | — | 主域名 |
| `SUBDOMAINS` | 是 | — | 逗号分隔的 RR 列表 |
| `RECORD_TTL` | 否 | `600` | A / AAAA 的 TTL（秒） |
| `INTERVAL_SECONDS` | 否 | `600` | 轮询间隔（秒） |
| `IP_URLS` | 否 | oray / 4.ipw.cn / ipify / ifconfig.me | IPv4 探测源，按顺序回退 |
| `ENABLE_IPV6` | 否 | `0` | 是否同时维护 AAAA |
| `IPV6_URLS` | 否 | 6.ipw.cn / ipv6.icanhazip.com / ipv6.ident.me | IPv6 探测源 |
| `DRY_RUN` | 否 | `0` | `1` = 只查询不写入 |
| `RUN_ONCE` | 否 | `0` | `1` = 跑一轮退出 |

## IPv6

开启前确认：本机有公网 IPv6（不是 `fe80::` / `fd00::`），防火墙已放行服务端口，然后设 `ENABLE_IPV6=1`。

容器因此使用 `network_mode: host`——Docker 默认 bridge 没有 IPv6，容器访问不了 IPv6-only 的探测地址。容器不监听端口，host 网络只用于出站。

## 构建策略

镜像由 `.github/workflows/build.yml` 构建：

- **测试**：`npm ci` + `node --test` + 语法检查，PR 也会跑。
- **构建指纹**：`应用版本 + package-lock 哈希 + 源码哈希 + Dockerfile 哈希 + node:22-alpine 的 digest`。定时任务只在指纹变化时构建。
- **多架构**：`linux/amd64` + `linux/arm64`（buildx + QEMU）。
- **依赖更新**：Dependabot 每周提 npm / GitHub Actions 的 PR；minor / patch 在 CI 通过后自动合并，major 留人工。基础镜像走浮动 tag，由每日指纹探测跟随补丁。
- **离线归档**：每次构建把两个架构的镜像 `docker save` 后附到 `ddns-<版本>` 的 GitHub Release，国内拉 GHCR 慢时可直接下载 `docker load`。

> **自动合并的前提**：仓库 Settings → General 打开 **Allow auto-merge**；给 `main` 配分支保护，要求 `测试` 检查通过、且必须走 PR。没有分支保护时 `gh pr merge --auto` 可能在测试完成前就合并。

## 安全

- 仓库和镜像中不含任何凭据；`.env` 被 `.gitignore` / `.dockerignore` 双重排除。
- CI 只用 `GITHUB_TOKEN`（`packages: write` / Release 用 `contents: write`），不需要 PAT。
- 建议使用只授予 `AliyunDNSFullAccess` 的 RAM 子账号，并定期轮换。
