#!/usr/bin/env bash
# ==================== omp-inn 自签名代码签名证书（一次性本机设置） ====================
# 为什么需要它：macOS 的 TCC（透明性、同意与控制：隐私授权）按「签名身份」记授权。
# 默认 adhoc 签名（signingIdentity: "-"）的签名身份是二进制 cdhash——每次构建都变，
# 系统于是把每个新版本当成新 app，反复弹「想访问"桌面"文件夹」。改用一张长期有效的
# 自签名证书签名后，只要证书不变，授权跨构建、跨应用内更新一直保留。
#
# 产物都在家目录（绝不进仓库）：
#   ~/.omp-inn-signing/cert.pem         证书
#   ~/.omp-inn-signing/key.pem          私钥
#   ~/.omp-inn-signing/signing.p12      CI 打包证书（含私钥）
#   ~/.omp-inn-signing/p12.pass         p12 密码
#   ~/.omp-inn-signing/signing.p12.b64  p12 的 base64（GitHub secrets 用）
# 证书 CN：Apple Development: omp-inn Signing（前缀是 tauri 认身份的硬要求），
# 安装到「登录」钥匙串（登录钥匙串平时已解锁，签名不弹框）。
#
# 运行本脚本时会出现的系统对话框（各一次，之后不再出现）：
#   1) 「security 想导入密钥到"登录"钥匙串」→ 输入你的登录密码；
#   2) 「security 想修改信任设置」→ 输入你的登录密码 / 点允许（让系统信任这张证书，仅代码签名用途）；
#   3) 「codesign 想使用密钥"Apple Development: omp-inn Signing"」→ 点「始终允许」（末尾的签名冒烟会触发）。
#
# 用法：
#   bash scripts/make-signing-cert.sh           # 生成 + 安装（已装过则打印现状）
#   bash scripts/make-signing-cert.sh --force   # 重新生成证书（轮换；会先删登录钥匙串里的旧证书）
#
# 卸载（如需）：打开「钥匙串访问」，搜索 Apple Development: omp-inn Signing，右键删除该证书（连同私钥），
# 再删掉本目录（~/.omp-inn-signing）与仓库 Secrets（APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD）。

set -euo pipefail
umask 077

# CN 必须带 Apple 证书前缀：tauri 的签名身份解析（tauri-macos-sign）只按 7 个前缀
# （Apple Development: / Developer ID Application: / Mac Development: 等）在钥匙串里
# 找证书，不带前缀的自签名证书会被当成「找不到签名身份」——Release 构建报
# "failed to resolve signing identity"。OU 也不可缺：解析证书要求 organizationalUnit。
CN="Apple Development: omp-inn Signing"
DIR="$HOME/.omp-inn-signing"
LOGIN_KC="$HOME/Library/Keychains/login.keychain-db"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1
HAVE_CERT_FILES=0
[[ -f "$DIR/cert.pem" && -f "$DIR/key.pem" && -f "$DIR/signing.p12" && -f "$DIR/p12.pass" ]] && HAVE_CERT_FILES=1

secrets_hint() {
  cat <<EOF

把证书喂给 Release 工作流（在仓库根目录执行；两个 secret 都从文件读、不进命令行历史）：
  gh secret set APPLE_CERTIFICATE < "$DIR/signing.p12.b64"
  gh secret set APPLE_CERTIFICATE_PASSWORD < "$DIR/p12.pass"
EOF
}

# ---------- 1. 生成证书文件（幂等；--force 重生成） ----------
if [[ $HAVE_CERT_FILES -eq 0 || $FORCE -eq 1 ]]; then
  mkdir -p "$DIR"
  if [[ $FORCE -eq 1 && $HAVE_CERT_FILES -eq 1 ]]; then
    echo "→ --force：删除登录钥匙串里的旧证书（如有）"
    security delete-certificate -c "$CN" "$LOGIN_KC" 2>/dev/null || true
  fi
  if [[ $FORCE -eq 1 ]]; then
    rm -f "$DIR/cert.pem" "$DIR/key.pem" "$DIR/signing.p12" "$DIR/p12.pass" "$DIR/signing.p12.b64"
  fi

  CONF="$(mktemp)"
  trap 'rm -f "$CONF"' EXIT
  cat > "$CONF" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = $CN
O = omp-inn
OU = omp-inn

[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

  echo "→ 生成自签名证书（10 年有效，仅用于代码签名）"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -config "$CONF" 2>/dev/null

  P12_PASS="$(openssl rand -base64 24)"
  # p12 必须用「旧式」算法（RC2/3DES + SHA1）打包：CI 里 tauri CLI 用 macOS 的
  # `security import` 导入它，而 security 认不了 OpenSSL 3 默认的 PBES2/AES-256
  #（报 "MAC verification failed during PKCS12 import"，Release 构建会在此失败）。
  # OpenSSL 3.x 加 -legacy 回到经典格式；LibreSSL / OpenSSL 1.x 没有该选项、默认即旧式。
  # 本机导入不走 p12（直接导 PEM）——这份 p12 只为 CI 的 secrets。
  if openssl pkcs12 -help 2>&1 | grep -q -- "-legacy"; then
    openssl pkcs12 -export -legacy -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
      -name "$CN" -out "$DIR/signing.p12" -passout "pass:$P12_PASS"
  else
    openssl pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
      -name "$CN" -out "$DIR/signing.p12" -passout "pass:$P12_PASS"
  fi
  printf '%s' "$P12_PASS" > "$DIR/p12.pass"
  base64 -i "$DIR/signing.p12" | tr -d '\n' > "$DIR/signing.p12.b64"
  echo "✔ 证书文件已生成：$DIR"
fi

# ---------- 1.5 兜底：确保 p12 的 base64 存在（给 CI secrets） ----------
if [[ ! -f "$DIR/signing.p12.b64" ]]; then
  base64 -i "$DIR/signing.p12" | tr -d '\n' > "$DIR/signing.p12.b64"
fi

# ---------- 2. 安装到登录钥匙串（幂等） ----------
if security find-certificate -c "$CN" "$LOGIN_KC" >/dev/null 2>&1; then
  echo "✔ 证书已在登录钥匙串"
else
  echo "→ 导入证书（如弹出系统对话框，请输入登录密码）"
  security import "$DIR/cert.pem" -k "$LOGIN_KC" -T /usr/bin/codesign -T /usr/bin/security
fi

if security find-identity -p codesigning "$LOGIN_KC" 2>/dev/null | grep -q "$CN"; then
  echo "✔ 私钥已在登录钥匙串"
else
  echo "→ 导入私钥（如弹出系统对话框，请输入登录密码）"
  security import "$DIR/key.pem" -k "$LOGIN_KC" -T /usr/bin/codesign -T /usr/bin/security
fi

# ---------- 2.5 信任这张证书（仅代码签名用途；否则自签名身份可能不被签名工具识别） ----------
if security dump-trust-settings 2>/dev/null | grep -q "$CN"; then
  echo "✔ 证书已受信任"
else
  echo "→ 设置信任（如弹出系统对话框，请输入登录密码 / 点允许）"
  security add-trusted-cert -r trustRoot -p codeSign -k "$LOGIN_KC" "$DIR/cert.pem"
fi

# ---------- 3. 验证身份可见 ----------
if ! security find-identity -p codesigning "$LOGIN_KC" 2>/dev/null | grep -q "$CN"; then
  echo "✗ 登录钥匙串里还没看到身份：请把本脚本的输出与系统弹框的情况发回排查"
  exit 1
fi

# ---------- 4. 签名冒烟（触发一次「始终允许」，之后构建不再弹） ----------
SMOKE="$(mktemp -d)/smoke"
cp /bin/ls "$SMOKE"
echo "→ 签名冒烟：如弹出「codesign 想使用密钥」对话框，请点「始终允许」"
codesign --force -s "$CN" "$SMOKE"
echo "✔ 签名冒烟成功（$CN）"
rm -rf "$(dirname "$SMOKE")"

# ---------- 5. 汇总 ----------
echo "✔ 完成：$(security find-identity -p codesigning "$LOGIN_KC" | grep -m1 "$CN" | sed -E 's/^[[:space:]]+//')"
echo "✔ 本地构建：pnpm tauri:build（自动用这张证书签名）"
secrets_hint
