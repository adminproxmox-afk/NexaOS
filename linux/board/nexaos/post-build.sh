#!/bin/sh
set -eu
install -d -m 0755 "$1/boot"
chmod 0755 "$1/init" "$1/etc/nexaos-start"
