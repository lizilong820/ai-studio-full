# 部署说明

## 一键部署

```bash
cd ai-studio-full
scripts/deploy.sh
```

脚本会先做语法检查，将代码同步到服务器临时目录，再以 `aistudio` 用户写入
`/var/www/ai-studio-full`，最后重启 `ai-studio.service` 并等待 `/readyz` 通过。

## 必须遵守的规则

以下内容属于**线上运行数据**，只能存在于服务器，禁止由本地覆盖：

| 路径 | 说明 |
| --- | --- |
| `public/uploads` | 线上是指向 `/var/lib/ai-studio/uploads` 的软链接，存放所有用户生成图片 |
| `public/audio` | 用户音频文件 |
| `database/*.db*` | 线上 SQLite 数据库 |
| `.env` | 线上环境变量与密钥 |
| `node_modules` | 服务器自行安装 |
| `tmp` | 运行时临时文件 |

`public/uploads` 在本地是 gitignore 的测试图片目录。如果部署时把它同步上去，
线上软链接会被替换成普通目录，历史图片会全部 404（2026-11-16 已发生过一次）。
`scripts/deploy.sh` 已排除该目录，并在重启前检查它仍是软链接。

如果软链接意外丢失，恢复方式：

```bash
sudo systemctl stop ai-studio.service
sudo mv /var/www/ai-studio-full/public/uploads /var/lib/ai-studio/quarantine/public-uploads-$(date +%Y%m%d)
sudo ln -s /var/lib/ai-studio/uploads /var/www/ai-studio-full/public/uploads
sudo chown -h aistudio:aistudio /var/www/ai-studio-full/public/uploads
sudo systemctl start ai-studio.service
curl -s http://127.0.0.1:3000/readyz
```

不要通过复制图片或修改数据库记录来“修复”这个问题。
