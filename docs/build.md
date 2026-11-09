# Сборка NexaOS 0.3

## Ubuntu и WSL2

Установите зависимости на хосте Ubuntu 24.04 x86-64.

```bash
sudo apt update
sudo apt install -y build-essential bc binutils bison ca-certificates cpio curl \
  cmake e2fsprogs file flex git gzip libncurses-dev ninja-build patch perl python3 rsync tar unzip \
  util-linux wget xz-utils
```

Под Windows выполните эти команды внутри Ubuntu WSL2. Рабочая копия может находиться на Windows-диске. Скрипт переносит внешний слой Buildroot в файловую систему Linux и строит там от обычного пользователя. В WSL он задаёт Linux-пути для инструментов, поскольку Buildroot отклоняет пробелы в `PATH`.

```bash
bash scripts/build-linux.sh
```

Скрипт проверяет SHA-256 Buildroot 2025.02.19 и загружает закреплённый набор исходников. Buildroot проверяет SHA-256 Linux 6.12.27 и остальных пакетов. Конфигурация использует Bootlin i686 musl stable 2024.05-1, BusyBox 1.37.0 и сборку cpio с gzip. На первой сборке потребуется сетевой доступ и несколько гигабайт места.

Переменные окружения управляют сборкой.

- `NEXAOS_JOBS=4` ограничивает параллелизм.
- `NEXAOS_BUILD_DIR="$HOME/.cache/nexaos-clean"` создаёт независимое дерево сборки. По умолчанию используется `${XDG_CACHE_HOME:-$HOME/.cache}/nexaos`. Для чистой проверки изменённого defconfig или конфигурации ядра укажите новый каталог.
- `NEXAOS_LEGAL_INFO=1` запускает цель `legal-info` и сохраняет отчёт в `output-2025.02.19/legal-info/`.

После успешной сборки `assets/bzImage` и `assets/rootfs.cpio.gz` готовы к загрузке. Оригиналы находятся в `output-2025.02.19/images/` внутри каталога сборки. Скрипт выводит SHA-256 обоих файлов и при первом запуске создаёт пустой `assets/nexa-data.ext4`. При пересборке запускайте гостя после завершения копирования образов.

### Настройка Buildroot

Редактируйте `linux/configs/nexaos_defconfig`, `linux/board/nexaos/linux.config` и `linux/rootfs-overlay/` в репозитории. После первой сборки меню открывается следующей командой.

```bash
cd "${XDG_CACHE_HOME:-$HOME/.cache}/nexaos"
env PATH=/usr/local/bin:/usr/bin:/bin make -C buildroot-2025.02.19 \
  O="$PWD/output-2025.02.19" BR2_EXTERNAL="$PWD/external" menuconfig
```

Меню работает с копией конфигурации в каталоге сборки. Скрипт повторно загружает defconfig из репозитория при следующем запуске. Подробнее см. [руководство Buildroot](https://buildroot.org/downloads/manual/manual.html).

## Проверка в Chromium

Запустите сервер по [README](../README.md). Выполните команды из корня проекта при наличии Node.js и Chrome.

```text
npx --yes --package @playwright/cli playwright-cli -s=nexaos-smoke open http://127.0.0.1:8000 --browser=chrome
npx --yes --package @playwright/cli playwright-cli -s=nexaos-smoke run-code --filename tests/browser-smoke.js
npx --yes --package @playwright/cli playwright-cli -s=nexaos-smoke run-code --filename tests/disk-smoke.js
npx --yes --package @playwright/cli playwright-cli -s=nexaos-smoke run-code --filename tests/desktop-smoke.js
npx --yes --package @playwright/cli playwright-cli -s=nexaos-smoke close
```

Первая проверка запускает Linux и демонстрационный ISO, выполняет команды внутри гостя и проверяет базовые функции загрузчика. Дисковая проверка пишет уникальный файл, проверяет восстановление после ошибки IndexedDB, выключает VM, перезагружает страницу и читает сохранённый файл. Графическая проверка ждёт готовности X.Org, сверяет режим VGA и проверяет процессы гостя через COM1.

### Проверка ext4 в 0.3

В Chrome на Windows гость смонтировал `/dev/sda` с ext4 в `/home/user`. Уникальный файл сохранился после выключения, перезагрузки страницы и нового входа в Linux. Файл в `/tmp` исчез. После повторного запуска также сохранилось удаление файла.

Вторая вкладка получила отказ в доступе к занятому диску. При искусственном отказе IndexedDB гость снял заморозку и принял запись. Повторное выключение сохранило диск с открытым на запись дескриптором в госте.

Копия сохранённого образа из IndexedDB прошла все пять этапов `e2fsck -fn`.

### Результаты проверки 0.2

Сборка завершилась в WSL2 Ubuntu 24.04. В Chrome на Windows сквозной тест прошёл для NexaOS, демонстрационного ISO и прямой загрузки с VGA.

- Баннер, `nexaos login:`, вход как `user` с UID 1000 и `pwd` с результатом `/home/user`.
- `uname -a` с результатом `Linux nexaos 6.12.27-nexaos … i686 GNU/Linux`, `ls`, `mkdir`, `cat`, `ps` и `mount`.
- BusyBox init с PID 1 и монтирование `/proc`, `/sys`, `/dev`, `/tmp` и `/dev/pts`. При настройках 128, 256 и 512 МиБ ядро видело примерно 103, 230 и 484 МиБ доступной памяти. Демонстрационный ISO загружен с 64 МиБ.
- Холодная перезагрузка с потерей созданного файла, выключение, переключение фокуса, полноэкранный режим и мобильная ширина 390 пикселей.
- Восстановление после HTTP 404 для ядра и после повреждения WebAssembly, отмена загрузки и сообщение о превышении времени ожидания остановки v86.

В логе ядра v86 может появиться `mce: Unable to init MCE device (rc: -5)`. В проверенном сеансе после этого продолжилась загрузка до входа.

Контрольные суммы SHA-256 проверенных образов

```text
eec380ed0d5ff480daa0d558279abad185d12048696db1127953bed09a2b26a4  bzImage
16a3625f0a97c8e4ea808f700c136493502088f60a0b5194d59c1525d4fe16e9  rootfs.cpio.gz
```

## Источники компонентов

- Buildroot, Linux и BusyBox загружаются при сборке. Конфигурация и изменения гостевого userspace находятся в `linux/`. См. [Buildroot LTS](https://buildroot.org/lts.html), [исходники ядра](https://www.kernel.org/pub/linux/kernel/v6.x/) и [исходники BusyBox](https://busybox.net/downloads/).
- Установка браузера получает закреплённые версии v86 0.5.473, xterm.js 6.0.0 и FitAddon 0.11.0 и извлекает их лицензии в `assets/`. BIOS берётся из закреплённой ревизии v86. См. [v86 и лицензии](https://github.com/copy/v86), [SeaBIOS](https://www.seabios.org/) и [xterm.js](https://github.com/xtermjs/xterm.js).
- `linux.iso` сохраняет демообраз 0.1. Это исторический образ для локальной проверки эмуляции. См. [каталог тестовых образов v86](https://github.com/copy/images).

При распространении собранных образов используйте исходники и уведомления соответствующих компонентов. В проверенной сборке `legal-info` создал отчёт и собрал материалы Linux и BusyBox. Архив Buildroot остался в каталоге сборки, а файлы лицензий Bootlin необходимо брать у поставщика. Браузерные зависимости, BIOS и сторонний ISO учитываются отдельно. Архивы для сборки и двоичные файлы не входят в Git. См. [исходники инструментов Bootlin](https://toolchains.bootlin.com/).
