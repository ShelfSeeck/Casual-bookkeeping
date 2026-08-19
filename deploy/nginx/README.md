# Nginx 配置

`casual-account-ip.conf.template` 是 Casual Account 的 Nginx 配置模板，已去除服务器
地址和部署路径等环境信息。模板中的占位符需要在安装前替换：

```text
__CB_PUBLIC_HOST__
__CB_PUBLIC_PORT__
__CB_BACKEND_PORT__
__CB_DEPLOY_ROOT__
```

服务器上的实际文件路径是：

```text
/etc/nginx/conf.d/casual-account-ip.conf
```

查看服务器时同步下来的完整环境配置保存在本地：

```text
deploy/nginx/casual-account-ip.local.conf
```

该文件被 `.gitignore` 忽略，不会被提交或推送，原因是其中包含当前服务器地址和路径。

当前配置的职责：

- 在 HTTPS 端口提供静态前端。
- 从 `<CB_DEPLOY_ROOT>/frontend/dist` 托管 PWA。
- 将 `/auth/`、`/sync/`、`/chat/` 代理到本机后端。
- 为 `/chat/` 保留 SSE 长连接需要的配置（关闭代理缓冲、延长读取超时）。

## 修改和安装流程

1. 修改 `casual-account-ip.conf.template`，不要把服务器地址直接写进模板。
2. 在本地替换占位符，例如：

   ```bash
   sed \
     -e 's#__CB_PUBLIC_HOST__#your-server.example.com#g' \
     -e 's#__CB_PUBLIC_PORT__#8080#g' \
     -e 's#__CB_BACKEND_PORT__#8001#g' \
     -e 's#__CB_DEPLOY_ROOT__#/home/your-user/Projects/Casual-Account#g' \
     deploy/nginx/casual-account-ip.conf.template \
     > /tmp/casual-account-ip.conf
   ```

3. 上传到服务器临时位置：

   ```bash
   scp /tmp/casual-account-ip.conf user@your-host:/tmp/casual-account-ip.conf
   ```

4. 在服务器上安装前检查配置：

   ```bash
   sudo install -o root -g root -m 644 \
     /tmp/casual-account-ip.conf \
     /etc/nginx/conf.d/casual-account-ip.conf
   sudo nginx -t
   sudo systemctl reload nginx
   ```

如果 `nginx -t` 失败，不要 reload，先修复配置。
