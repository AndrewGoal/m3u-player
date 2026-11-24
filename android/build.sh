#!/usr/bin/env bash
#
# 构建 Android TV 壳（不用 Gradle：aapt2 + javac + d8 + apksigner）。
#
#   ./build.sh                    # 完整版 APK：android/m3u-player-tv.apk
#   ./build.sh --simple           # 简洁版 APK：android/m3u-player-tv-simple.apk
#   ./build.sh --tv               # 看电视 APK：android/m3u-player-tv-last.apk
#   ./build.sh --install          # 构建并 adb install -r
#   ./build.sh --simple --launch  # 构建、安装并启动简洁版
#
# 环境变量：
#   ANDROID_SDK_ROOT  默认 ~/Android/sdk
#   SERIAL            默认取 adb 里唯一的设备
#   TV_URL            仅 --launch：临时指定启动地址（不改 APK 里的默认值）
#   KEYSTORE          签名密钥位置（默认 ~/.config/m3u-player-tv/tv.jks，自动生成）
set -euo pipefail
cd "$(dirname "$0")"

VARIANT="full"
ACTION=""
for arg in "$@"; do
  case "$arg" in
    --simple|simple) VARIANT="simple" ;;
    --tv|tv) VARIANT="tv" ;;
    --full|full) VARIANT="full" ;;
    --install|--launch) ACTION="$arg" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

if [ "$VARIANT" = "simple" ]; then
  MANIFEST="simple/AndroidManifest.xml"
  RES_DIR="simple/res"
  ACTIVITY_SRC="simple/src/io/github/andrewgoal/m3uplayer/simple/SimpleActivity.java"
  PACKAGE="io.github.andrewgoal.m3uplayer.simple"
  ACTIVITY=".SimpleActivity"
  APP="m3u-player-tv-simple.apk"
elif [ "$VARIANT" = "tv" ]; then
  MANIFEST="tv/AndroidManifest.xml"
  RES_DIR="tv/res"
  ACTIVITY_SRC="tv/src/io/github/andrewgoal/m3uplayer/tv/TvActivity.java"
  PACKAGE="io.github.andrewgoal.m3uplayer.tv"
  ACTIVITY=".TvActivity"
  APP="m3u-player-tv-last.apk"
else
  MANIFEST="AndroidManifest.xml"
  RES_DIR="res"
  ACTIVITY_SRC="src/io/github/andrewgoal/m3uplayer/MainActivity.java"
  PACKAGE="io.github.andrewgoal.m3uplayer"
  ACTIVITY=".MainActivity"
  APP="m3u-player-tv.apk"
fi

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/34.0.0}"
PLATFORM="${PLATFORM:-$SDK/platforms/android-34/android.jar}"
MIN_SDK=21
TARGET_SDK=33
OUT="build/$VARIANT"
KEYSTORE="${KEYSTORE:-$HOME/.config/m3u-player-tv/tv.jks}"
STOREPASS="${STOREPASS:-m3u-player-tv}"

# build-tools 34 的 d8 在 JDK 21+ 上会崩（已知 NPE），优先用 17
if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in /usr/lib/jvm/java-17-openjdk "$HOME/.jdks"/*17*; do
    if [ -x "$candidate/bin/java" ]; then
      JAVA_HOME="$candidate"
      break
    fi
  done
fi
if [ -n "${JAVA_HOME:-}" ]; then
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
fi

for tool in aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BUILD_TOOLS/$tool" ]; then
    echo "缺少 $BUILD_TOOLS/$tool" >&2
    echo "先安装：sdkmanager \"build-tools;34.0.0\" \"platforms;android-34\"" >&2
    exit 1
  fi
done
[ -f "$PLATFORM" ] || { echo "缺少 android.jar：$PLATFORM" >&2; exit 1; }

# 简洁版要 ExoPlayer（Media3），依赖在 vendor/ 里，首次构建自动下载
VENDOR_CP=""
VENDOR_RES=()
if [ "$VARIANT" != "full" ]; then
  if [ ! -d vendor/jars ] || [ -z "$(ls -A vendor/jars 2>/dev/null)" ]; then
    echo "==> 拉取 ExoPlayer 依赖"
    ./fetch-deps.sh
  fi
  VENDOR_CP=$(ls vendor/jars/*.jar | tr '\n' ':')
  if [ -d vendor/res ]; then
    for dir in vendor/res/*/; do
      [ -d "$dir" ] && VENDOR_RES+=("${dir%/}")
    done
  fi
fi

echo "==> 资源（$VARIANT）"
rm -rf "$OUT"
mkdir -p "$OUT/compiled" "$OUT/classes" "$OUT/dex" "$OUT/gen"
"$BUILD_TOOLS/aapt2" compile --dir "$RES_DIR" -o "$OUT/compiled/res.zip"
RES_ARGS=(-R "$OUT/compiled/res.zip")
for dir in "${VENDOR_RES[@]:-}"; do
  [ -n "$dir" ] || continue
  name=$(basename "$dir")
  "$BUILD_TOOLS/aapt2" compile --dir "$dir" -o "$OUT/compiled/$name.zip"
  RES_ARGS+=(-R "$OUT/compiled/$name.zip")
done
"$BUILD_TOOLS/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$MANIFEST" \
  "${RES_ARGS[@]}" \
  --java "$OUT/gen" \
  --auto-add-overlay \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK"

echo "==> 编译 Java"
JAVA_SRC=(src/io/github/andrewgoal/m3uplayer/ShellActivity.java "$ACTIVITY_SRC")
if [ "$VARIANT" = "simple" ]; then
  while IFS= read -r file; do JAVA_SRC+=("$file"); done < <(find simple/src -name '*.java' ! -name 'SimpleActivity.java')
elif [ "$VARIANT" = "tv" ]; then
  # 看电视版复用简洁版的全部实现，只换入口 Activity 和清单
  while IFS= read -r file; do JAVA_SRC+=("$file"); done < <(find simple/src -name '*.java')
  while IFS= read -r file; do JAVA_SRC+=("$file"); done < <(find tv/src -name '*.java' ! -name 'TvActivity.java')
fi
set -o pipefail
javac -source 8 -target 8 -encoding UTF-8 -bootclasspath "$PLATFORM" \
  ${VENDOR_CP:+-cp "$VENDOR_CP"} \
  -d "$OUT/classes" \
  "${JAVA_SRC[@]}" \
  $(find "$OUT/gen" -name '*.java') 2>&1 \
  | grep -v -e "bootstrap class path" -e "source value 8" -e "target value 8" -e "Xlint:-options" \
  || { echo "javac 失败" >&2; exit 1; }

echo "==> dex"
DEX_INPUTS=($(find "$OUT/classes" -name '*.class'))
if [ "$VARIANT" != "full" ]; then
  DEX_INPUTS+=(vendor/jars/*.jar)
fi
"$BUILD_TOOLS/d8" --min-api "$MIN_SDK" --lib "$PLATFORM" --output "$OUT/dex" "${DEX_INPUTS[@]}"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q ../unsigned.apk classes.dex)

echo "==> 对齐 + 签名"
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias m3u-player -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -dname "CN=m3u-player TV, O=AndrewGoal, C=CN" >/dev/null 2>&1
  echo "    已生成签名密钥：$KEYSTORE"
fi
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$STOREPASS" \
  --key-pass "pass:$STOREPASS" --out "$APP" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" verify "$APP"

echo "==> 完成：android/$APP ($(du -h "$APP" | cut -f1))"

ADB=(adb)
[ -n "${SERIAL:-}" ] && ADB=(adb -s "$SERIAL")

if [ "$ACTION" = "--install" ] || [ "$ACTION" = "--launch" ]; then
  echo "==> 安装"
  "${ADB[@]}" install -r "$APP"
fi

if [ "$ACTION" = "--launch" ]; then
  echo "==> 启动"
  "${ADB[@]}" shell am force-stop "$PACKAGE"
  if [ -n "${TV_URL:-}" ]; then
    "${ADB[@]}" shell am start -n "$PACKAGE/$ACTIVITY" -e url "$TV_URL"
  else
    "${ADB[@]}" shell am start -n "$PACKAGE/$ACTIVITY"
  fi
fi
