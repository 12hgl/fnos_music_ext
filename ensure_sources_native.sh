#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# fnmusic-ext 原生（无 Docker）音源运行时保障
# 由 install.sh / extend.sh 在 FNMUSIC_DEPLOY_MODE=native 时调用，也可手动重跑。
# 对齐 container/Dockerfile 的镜像层职责，全部落在宿主机：
#   1. 确保 .venv-sources 存在，安装五服务 requirements 并集 + supervisor
#      （容器内由镜像 pip 层安装；多 pip 源回退链与 ensure_proxy_deps.sh 同策略）
#   2. 检测 nodejs（洛雪自定义源 Node 沙箱 bridge.js）/ ffmpeg（musicdl 无损探针），
#      缺失时尝试 sudo apt-get 安装，失败给出手动命令
# 本脚本不修改任何系统配置（apt 安装除外，且仅补缺失的两组件）。
# 可调环境变量: PIP_INDEX / FNMUSIC_VENV_SOURCES_DIR / FNMUSIC_APT_MIRROR
# ==============================================================================

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${FNMUSIC_VENV_SOURCES_DIR:-${BASE_DIR}/.venv-sources}"
PIP_INDEX="${PIP_INDEX:-https://mirrors.tencent.com/pypi/simple/}"
FALLBACK_INDEXES="https://mirrors.aliyun.com/pypi/simple/ https://pypi.tuna.tsinghua.edu.cn/simple https://pypi.org/simple"
APT_MIRROR="${FNMUSIC_APT_MIRROR:-}"

log_info() { echo -e "\033[32m[INFO]\033[0m $*"; }
log_warn() { echo -e "\033[33m[WARN]\033[0m $*"; }
log_err() { echo -e "\033[31m[ERROR]\033[0m $*" >&2; }

# ---------------------------------------------------------------- 1. venv + pip
REQ_FILES=(
    "${BASE_DIR}/musicdl-service/requirements.txt"
    "${BASE_DIR}/musicbox-service/requirements.txt"
    "${BASE_DIR}/neteasefree-service/requirements.txt"
    "${BASE_DIR}/lxmusic-service/requirements.txt"
    "${BASE_DIR}/webui-service/requirements.txt"
)
for req in "${REQ_FILES[@]}"; do
    if [ ! -f "${req}" ]; then
        log_err "缺少依赖清单: ${req}"
        exit 1
    fi
done

if [ ! -x "${VENV_DIR}/bin/python" ]; then
    log_info "创建虚拟环境 ${VENV_DIR} ..."
    python3 -m venv "${VENV_DIR}"
fi
PIP_BIN="${VENV_DIR}/bin/pip"
if [ ! -x "${PIP_BIN}" ]; then
    log_err "虚拟环境异常：${PIP_BIN} 不存在。"
    log_err "可删除 ${VENV_DIR} 后重跑本脚本重建。"
    exit 1
fi

# supervisor 经 pip 安装（容器内为 apt supervisor；pip 包即同一项目，含
# supervisord/supervisorctl），免去一个系统依赖；supervisorctl -c 指向渲染后的配置。
candidates="${PIP_INDEX}"
for idx in ${FALLBACK_INDEXES}; do
    [ "${idx}" = "${PIP_INDEX}" ] || candidates="${candidates} ${idx}"
done

ok_index=""
REQ_ARGS=()
for req in "${REQ_FILES[@]}"; do
    REQ_ARGS+=("-r" "${req}")
done
for idx in ${candidates}; do
    log_info "尝试 pip 源: ${idx}"
    if "${PIP_BIN}" install -q -U pip --retries 2 --timeout 30 -i "${idx}" \
       && "${PIP_BIN}" install -q supervisor "${REQ_ARGS[@]}" --retries 2 --timeout 30 -i "${idx}"; then
        ok_index="${idx}"
        break
    fi
    log_warn "pip 源不可用: ${idx}，切换下一候选源重试..."
done
if [ -z "${ok_index}" ]; then
    log_err "所有 pip 源均安装失败（尝试了: ${candidates}）。"
    log_err "排查建议：1) 检查宿主机网络 / DNS / 代理（含 http_proxy、https_proxy 环境变量）；"
    log_err "           2) 换源重试: PIP_INDEX=<其他源URL> bash $(basename "${BASH_SOURCE[0]}")。"
    exit 1
fi
log_info "音源服务 Python 依赖安装完成（pip 源: ${ok_index}）。"

# ------------------------------------------------------- 2. nodejs / ffmpeg
apt_install_missing() {
    # $@ = 系统包名列表；返回仍缺失的命令数
    local missing=() pkg cmd
    for pkg in "$@"; do
        if ! command -v "${pkg}" >/dev/null 2>&1; then
            missing+=("${pkg}")
        fi
    done
    [ "${#missing[@]}" -eq 0 ] && return 0
    log_warn "检测到缺失系统组件: ${missing[*]}，尝试 sudo apt-get 安装..."
    if command -v apt-get >/dev/null 2>&1 && sudo apt-get update -o Acquire::Retries=1 2>/dev/null \
        && sudo apt-get install -y --no-install-recommends "${missing[@]}"; then
        return 0
    fi
    log_err "apt 自动安装失败，请手动安装后重跑："
    log_err "  sudo apt-get update && sudo apt-get install -y ${missing[*]}"
    return 1
}

# node 命令由 nodejs 包提供（Debian 12 自带 18.x，满足洛雪自定义源 Node 沙箱要求）
if ! command -v node >/dev/null 2>&1; then
    apt_install_missing nodejs || {
        log_err "缺少 nodejs：洛雪自定义源（lxmusic）无法运行。"
        exit 1
    }
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 16 ]; then
    log_err "nodejs 版本过低（${NODE_MAJOR} < 16）：洛雪自定义源需要 Node 16+。请升级后重跑。"
    exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
    apt_install_missing ffmpeg || {
        log_err "缺少 ffmpeg：musicdl 无损流探针不可用（不影响其他音源）。"
        log_err "如不需要 musicdl 可忽略此错误继续。"
        exit 1
    }
fi
log_info "系统组件就绪（node $(node --version 2>/dev/null || echo '?'), ffmpeg $(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}' || echo '?')）。"

log_info "原生音源运行时就绪。"