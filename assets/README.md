# Локальные образы

`scripts/setup-assets.py` устанавливает v86, BIOS, xterm.js и исходный демонстрационный ISO в этот каталог. `scripts/build-linux.sh` публикует сюда `bzImage` и `rootfs.cpio.gz` для NexaOS.

Двоичные файлы исключены из Git. Загрузчик ищет их по HTTP относительно `index.html`. Сборочные исходники и порядок подготовки описаны в [документации](../docs/build.md).
