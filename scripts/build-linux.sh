#!/usr/bin/env bash
set -euo pipefail

# Buildroot rejects spaces in PATH. WSL imports Windows paths by default.
if [[ -n ${WSL_DISTRO_NAME:-} ]]; then
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
version=2025.02.19
hash=e5e58bff1da91f022f60cefdfe280140c08023cd0aeec1e5f6f9da0ea866d69c
work=${NEXAOS_BUILD_DIR:-"${XDG_CACHE_HOME:-$HOME/.cache}/nexaos"}
jobs=${NEXAOS_JOBS:-$(nproc)}

if [[ $EUID == 0 ]]; then
    echo "Run the build as a regular Linux user." >&2
    exit 1
fi
if ! command -v mke2fs >/dev/null; then
    echo "Install e2fsprogs to generate the NexaOS ext4 seed disk." >&2
    exit 1
fi

mkdir -p -- "$work"
cd -- "$work"
work=$(pwd -P)
if [[ $(stat -f -c %T .) == 9p ]]; then
    echo "Choose a build directory in the WSL Linux filesystem, such as ~/.cache/nexaos." >&2
    exit 1
fi
exec 9>.build-lock
flock -n 9 || { echo "A NexaOS build is already using $work." >&2; exit 1; }

archive=buildroot-$version.tar.xz
if [[ ! -f $archive ]]; then
    curl -fL --retry 3 "https://buildroot.org/downloads/$archive" -o "$archive.part"
    printf '%s  %s\n' "$hash" "$archive.part" | sha256sum -c -
    mv -- "$archive.part" "$archive"
fi
printf '%s  %s\n' "$hash" "$archive" | sha256sum -c -

buildroot="$work/buildroot-$version"
if [[ ! -f $buildroot/Makefile ]]; then
    tar -xf "$archive"
fi

# Stage the external tree on Linux so WSL builds also work from /mnt/c or /mnt/e.
external="$work/external"
mkdir -p -- "$external"
rsync -rpt --delete --chmod=D755,F644 -- "$root/linux/" "$external/"
chmod +x "$external/board/nexaos/post-build.sh"

output="$work/output-$version"
export BR2_DL_DIR="$work/downloads"
make_args=(-C "$buildroot" "O=$output" "BR2_EXTERNAL=$external")
make "${make_args[@]}" nexaos_defconfig
make "${make_args[@]}" -j"$jobs"
if [[ ${NEXAOS_LEGAL_INFO:-0} == 1 ]]; then
    make "${make_args[@]}" legal-info
fi

mkdir -p -- "$root/assets"
exec 8>"$root/assets/.publish-lock"
flock 8
disk="$root/assets/nexa-data.ext4"
if [[ ! -f $disk ]]; then
    mke2fs -q -F -t ext4 -L NEXADATA -m 0 \
        -E root_owner=1000:1000,lazy_itable_init=0,lazy_journal_init=0 "$disk.part" 64M
    mv -f -- "$disk.part" "$disk"
fi
for image in bzImage rootfs.cpio.gz; do
    install -m 0644 "$output/images/$image" "$root/assets/$image.part"
    mv -f -- "$root/assets/$image.part" "$root/assets/$image"
done
sha256sum "$root/assets/bzImage" "$root/assets/rootfs.cpio.gz"
