#!/usr/bin/env bash
#
# 拉取 ExoPlayer（Media3）依赖，解出 classes.jar 与资源，供无 Gradle 构建使用。
#
#   ./fetch-deps.sh          # 缺什么下什么（已存在则跳过）
#   ./fetch-deps.sh --force  # 重新下载
#
# 产物都在 android/vendor/（.gitignore 里），不往仓库里塞二进制。
set -euo pipefail
cd "$(dirname "$0")"

FORCE=""
[ "${1:-}" = "--force" ] && FORCE=1

VERSION=1.4.1
GOOGLE=https://dl.google.com/dl/android/maven2
MAVEN=https://repo1.maven.org/maven2
OUT=vendor
JARS="$OUT/jars"
AARS="$OUT/aars"
mkdir -p "$JARS" "$AARS"

# group:artifact:version:仓库
DEPS=(
  "androidx.media3:media3-exoplayer:$VERSION:g"
  "androidx.media3:media3-exoplayer-hls:$VERSION:g"
  "androidx.media3:media3-common:$VERSION:g"
  "androidx.media3:media3-container:$VERSION:g"
  "androidx.media3:media3-datasource:$VERSION:g"
  "androidx.media3:media3-decoder:$VERSION:g"
  "androidx.media3:media3-extractor:$VERSION:g"
  "androidx.media3:media3-database:$VERSION:g"
  "androidx.annotation:annotation:1.3.0:g"
  "androidx.annotation:annotation-experimental:1.3.1:g"
  "androidx.collection:collection:1.2.0:g"
  "androidx.core:core:1.8.0:g"
  "androidx.exifinterface:exifinterface:1.3.6:g"
  "com.google.guava:guava:33.0.0-android:c"
  "com.google.guava:failureaccess:1.0.1:c"
  "com.google.guava:listenablefuture:9999.0-empty-to-avoid-conflict-with-guava:c"
)

for spec in "${DEPS[@]}"; do
  IFS=: read -r group artifact version repo <<<"$spec"
  path="${group//.//}/$artifact/$version/$artifact-$version"
  if [ "$repo" = "c" ]; then
    base="$MAVEN"
    ext="jar"
  else
    base="$GOOGLE"
    ext="aar"
  fi

  target="$AARS/$artifact-$version.$ext"
  if [ -n "$FORCE" ] || [ ! -f "$target" ]; then
    echo "==> $artifact $version"
    if ! curl -fsSL --retry 3 --max-time 120 -o "$target.tmp" "$base/$path.$ext"; then
      # 少数 androidx 模块只发 jar
      ext="jar"
      target="$AARS/$artifact-$version.jar"
      curl -fsSL --retry 3 --max-time 120 -o "$target.tmp" "$base/$path.jar"
    fi
    mv "$target.tmp" "$target"
  fi

  if [ "$ext" = "aar" ]; then
    if [ -n "$FORCE" ] || [ ! -f "$JARS/$artifact-$version.jar" ]; then
      unzip -p "$target" classes.jar > "$JARS/$artifact-$version.jar"
    fi
    if unzip -l "$target" | grep -q " res/"; then
      rm -rf "$OUT/res/$artifact"
      mkdir -p "$OUT/res/$artifact"
      unzip -q -o "$target" 'res/*' -d "$OUT/res/$artifact"
    fi
  else
    cp -f "$target" "$JARS/$artifact-$version.jar"
  fi
done

echo "==> 依赖就绪：$(ls "$JARS" | wc -l) 个 jar，$(du -sh "$OUT" | cut -f1)"
ls "$JARS"
