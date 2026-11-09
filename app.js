"use strict";

const $ = id => document.getElementById(id);
const profiles = {
  custom: {
    serial: true,
    disk: true,
    files: { bzimage: "bzImage", initrd: "rootfs.cpio.gz" },
    cmdline: "console=tty0 console=ttyS0,115200 rdinit=/init tsc=reliable mitigations=off nexa.disk=1 nomodeset",
    hint: "Linux i686 с постоянным каталогом /home/user.",
  },
  demo: {
    files: { cdrom: "linux.iso" },
    hint: "Исходный демонстрационный ISO с консолью VGA.",
  },
  legacy: {
    files: { bzimage: "bzImage", initrd: "rootfs.cpio.gz" },
    cmdline: "console=tty0 console=ttyS0,115200 rdinit=/init",
    hint: "Пара bzImage и initramfs из assets/ с выводом на VGA.",
  },
};
profiles.desktop = {
  ...profiles.custom,
  desktop: true,
  cmdline: profiles.custom.cmdline.replace("nomodeset", "nexa.desktop=1"),
  hint: "Гостевой X.Org с xterm и тем же каталогом /home/user.",
};

const labels = {
  off: "Выключена",
  loading: "Подготовка к запуску",
  booting: "Загрузка Linux",
  ready: "Linux готов",
  running: "Эмуляция активна",
  timeout: "Ожидание Linux",
  saving: "Сохранение диска",
  stopping: "Выключение",
  error: "Ошибка",
};

const machine = $("machine");
const screen = $("screen_container");
const terminalHost = $("terminal");
const progress = $("progress");
const encoder = new TextEncoder();
const MiB = 1024 * 1024;
const initrdOffset = 64 * MiB; // v86 0.5.473 loads the initrd at 64 MiB.
let session = null;

function diskMayBeMounted(vm) {
  return vm?.disk && (vm.diskReady || vm.banner);
}

function render(phase, message) {
  machine.dataset.phase = phase;
  $("statusDot").dataset.phase = phase;
  $("status").textContent = labels[phase];
  $("message").textContent = message;
  $("overlayTitle").textContent = phase === "off" ? "Готово к запуску" : labels[phase];
  $("overlayText").textContent = message;
  $("overlay").hidden = Boolean(session?.initialized);
  progress.hidden = phase !== "loading" && phase !== "booting";
  if (phase === "booting") progress.removeAttribute("value");
  $("start").disabled = $("profile").disabled = $("memory").disabled = Boolean(session);
  $("off").disabled = !session || session.closing || session.saving;
  $("reset").disabled = !session?.initialized || session.closing || session.saving;
  $("forceOff").hidden = !session?.saveFailed || session.closing || session.saving;
  $("switchDisplay").hidden = !session?.initialized || !session.profile.desktop || session.closing;
}

function renderProfile() {
  const profile = profiles[$("profile").value];
  const memory = $("memory");
  memory.querySelector('option[value="64"]').disabled = Boolean(profile.files.initrd);
  if (profile.files.initrd && memory.value === "64") memory.value = "128";
  $("profileHint").textContent = profile.hint;
  $("storageLabel").textContent = profile.disk ? "ext4 · 64 МиБ" : "Сеанс в RAM";
  renderDisplay(profile, profile.desktop || !profile.serial);
}

function renderDisplay(profile, vga) {
  $("consoleTitle").textContent = vga
    ? (profile.desktop ? "NexaDesktop" : "Экран гостевой системы")
    : "Последовательная консоль";
  $("consoleTag").textContent = vga ? (profile.desktop ? "X11 / VGA" : "VGA") : "TTY / COM1";
  $("switchDisplay").textContent = vga ? "Открыть COM1" : "Открыть VGA";
}

function showDisplay(vm, vga) {
  terminalHost.hidden = vga || !vm.profile.serial;
  screen.hidden = !vga;
  $("inputHint").textContent = vga
    ? "Нажмите на VGA для ввода · F6 возвращает фокус к управлению"
    : "Нажмите на терминал для ввода · Ctrl+] возвращает фокус к управлению";
  renderDisplay(vm.profile, vga);
}

function checkAsset(name, data) {
  const bytes = new Uint8Array(data);
  const valid = {
    bzImage: () => String.fromCharCode(...bytes.subarray(0x202, 0x206)) === "HdrS",
    "rootfs.cpio.gz": () => bytes[0] === 0x1f && bytes[1] === 0x8b,
    "linux.iso": () => String.fromCharCode(...bytes.subarray(32769, 32774)) === "CD001",
    "seabios.bin": () => bytes.length === 131072,
    "vgabios.bin": () => bytes[0] === 0x55 && bytes[1] === 0xaa,
  };
  if (valid[name] && !valid[name]()) throw new Error("Некорректный формат assets/" + name);
}

async function loadAsset(name, vm) {
  const response = await fetch("assets/" + name, { cache: "no-cache", signal: vm.downloads.signal }).catch(error => {
    throw new Error("Не удалось загрузить assets/" + name + ". " + error.message);
  });
  if (!response.ok) {
    const setup = ["bzImage", "rootfs.cpio.gz", "nexa-data.ext4"].includes(name)
      ? "build-linux.sh" : "setup.sh или setup.ps1";
    throw new Error("assets/" + name + " · HTTP " + response.status + ". Запустите scripts/" + setup + ".");
  }
  const buffer = await response.arrayBuffer();
  checkAsset(name, buffer);
  if (session === vm && !vm.closing) progress.value += 1;
  return buffer;
}

function openTerminal(vm) {
  terminalHost.hidden = false;
  const terminal = vm.terminal = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 14,
    scrollback: 2000,
    cursorBlink: !matchMedia("(prefers-reduced-motion: reduce)").matches,
    theme: { background: "#090d17", foreground: "#e0e7fa", cursor: "#a9a9ff" },
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(terminalHost);
  terminal.textarea.setAttribute("aria-label", "Терминал гостевой системы NexaOS");
  fit.fit();
  vm.resize = new ResizeObserver(() => fit.fit());
  vm.resize.observe(terminalHost);
  terminal.onData(data => {
    if (session === vm && vm.initialized && !vm.closing && !vm.saving) {
      vm.emulator.serial_send_bytes(0, encoder.encode(data));
    }
  });
}

function ready(vm) {
  if (session !== vm || vm.closing || vm.ready) return;
  if (vm.profile.disk && (!vm.diskReady || !vm.loginReady)) return;
  if (vm.profile.desktop && !vm.xReady) return;
  vm.ready = true;
  clearTimeout(vm.timer);
  const message = vm.profile.desktop
    ? "X.Org принимает подключения. COM1 доступен для диагностики."
    : vm.profile.serial ? "NexaOS запущена. Введите user и нажмите Enter." : "Гостевая оболочка ISO готова к вводу.";
  render("ready", message);
}

function serialByte(vm, byte) {
  if (session !== vm || vm.closing) return;
  vm.bytes.push(byte);
  if (!vm.frame) {
    vm.frame = requestAnimationFrame(() => {
      vm.frame = 0;
      vm.terminal.write(Uint8Array.from(vm.bytes));
      vm.bytes.length = 0;
    });
  }
  if (byte === 10) vm.line = "";
  else if (byte !== 13) vm.line = (vm.line + String.fromCharCode(byte)).slice(-180);
  if (vm.line === "Boot completed successfully.") vm.banner = true;
  if (vm.banner && vm.line === "nexaos login:") {
    vm.loginReady = true;
    ready(vm);
  }
  if (vm.line === "NEXA_DISK_FAILED") {
    clearTimeout(vm.timer);
    render("error", "Гость не смог подключить ext4 к /home/user. Сохранённый образ не изменён.");
  }
  if (vm.profile.desktop && vm.line === "NEXA_X_READY") {
    vm.xReady = true;
    ready(vm);
  }
  if (vm.profile.desktop && vm.line === "NEXA_X_STOPPED") {
    clearTimeout(vm.timer);
    showDisplay(vm, false);
    render(vm.xReady ? "running" : "error", vm.xReady
      ? "Графический сеанс завершился. Консоль COM1 продолжает работать."
      : "X.Org не запустился. Журналы гостя доступны через COM1 в /var/log/.");
  }
  if (/(?:^|\] )Kernel panic - not syncing:$/.test(vm.line)) reportPanic(vm);
}

function reportPanic(vm) {
  clearTimeout(vm.timer);
  clearInterval(vm.vgaPoll);
  render("error", "Ядро Linux остановилось. Подробности остались в консоли.");
}

function diskByte(vm, byte) {
  if (session !== vm || vm.closing) return;
  if (byte !== 10) {
    vm.diskLine = (vm.diskLine + String.fromCharCode(byte)).slice(-80);
    return;
  }
  const line = vm.diskLine.trim();
  vm.diskLine = "";
  if (line === "READY") {
    vm.diskReady = true;
    ready(vm);
  }
  vm.diskReply?.(line);
}

function diskRequest(vm, command, expected, refused) {
  const id = ++vm.diskSequence;
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      vm.diskReply = vm.cancelDiskReply = null;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Гость не ответил на " + command + ".")), 12_000);
    vm.cancelDiskReply = finish;
    vm.diskReply = line => {
      if (line === id + " " + expected) finish();
      if (line === id + " " + refused) finish(new Error(command === "FLUSH"
        ? "Гость не смог приостановить запись на ext4."
        : "Гость не восстановил режим записи диска."));
    };
    try {
      vm.emulator.serial_send_bytes(1, encoder.encode(id + " " + command + "\n"));
    } catch (error) {
      finish(error);
    }
  });
}

async function powerAction(restart) {
  const vm = session;
  if (!vm || vm.closing || vm.saving) return;
  let message = "Виртуальная машина выключена. Содержимое RAM сброшено.";
  if (vm.disk) message = "Сохранённый образ диска остался без изменений.";
  if (diskMayBeMounted(vm)) {
    let failure;
    vm.saving = true;
    render("saving", "Гость сбрасывает кэш и приостанавливает запись на ext4.");
    try {
      await diskRequest(vm, "FLUSH", "FLUSHED", "BUSY");
      if (vm.closing) return;
      vm.diskWrite = vm.disk.save();
      await vm.diskWrite;
      message = "Диск сохранён. Содержимое RAM сброшено.";
    } catch (error) {
      if (vm.closing) return;
      let recovery = "";
      try {
        await diskRequest(vm, "THAW", "THAWED", "THAW_FAILED");
      } catch (thawError) {
        recovery = " " + thawError.message;
      }
      failure = "Сохранение диска не завершилось. " + error.message + recovery;
    } finally {
      vm.saving = false;
    }
    if (vm.closing) return;
    if (failure) {
      vm.saveFailed = true;
      render("error", failure);
      return;
    }
  }
  await closeSession(vm, "off", message);
  if (restart && machine.dataset.phase === "off") await start();
}

function launchGuest(vm) {
  vm.initialized = true;
  clearTimeout(vm.timer);
  if (vm.closing) return;
  if (vm.hasVga) {
    vm.emulator.keyboard_set_enabled(document.activeElement === screen);
    vm.emulator.mouse_set_enabled(document.activeElement === screen);
  }

  if (vm.kind === "legacy") {
    render("running", "Проверьте вывод VGA. Для этого образа нет автоматической проверки готовности.");
  } else {
    render("booting", "v86 запущен. Ожидаем приглашение гостевой системы.");
    vm.timer = setTimeout(() => {
      if (session === vm && !vm.closing && !vm.ready) {
        if (vm.profile.desktop) showDisplay(vm, false);
        render("timeout", vm.profile.desktop
          ? "Графический сеанс не подтвердил готовность за 180 секунд. Проверьте COM1 и журналы /var/log/."
          : "Гость не подтвердил готовность за 180 секунд. Проверьте вывод консоли.");
      }
    }, 180_000);
  }

  if (!vm.profile.serial) {
    vm.vgaPoll = setInterval(() => {
      const text = screen.firstElementChild;
      if (text.textContent.includes("Kernel panic - not syncing")) reportPanic(vm);
      else if (vm.kind === "demo" && !vm.ready && /(?:^|\n)\s*\/root%\s*(?:\n|$)/.test(text.innerText)) ready(vm);
    }, 250);
  }
  vm.emulator.run().catch(error => fail(vm, error));
}

async function closeSession(vm, phase, message) {
  if (session !== vm || vm.closing) return;
  vm.closing = true;
  render("stopping", "Освобождаем ресурсы виртуальной машины.");
  vm.cancelDiskReply?.(new Error("Виртуальная машина останавливается."));
  vm.downloads.abort();
  clearInterval(vm.vgaPoll);
  cancelAnimationFrame(vm.frame);
  vm.resize?.disconnect();
  vm.terminal?.dispose();
  terminalHost.replaceChildren();
  terminalHost.hidden = true;
  try {
    // v86 can only destroy an instance after the guest hardware is initialized.
    if (vm.emulator && await vm.hardware) {
      let stopTimer;
      try {
        await Promise.race([
          vm.emulator.destroy(),
          new Promise((_, reject) => {
            stopTimer = setTimeout(() => reject(new Error("v86 не подтвердил остановку за 5 секунд.")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(stopTimer);
      }
    }
  } catch (error) {
    console.error(error);
    vm.cleanupFailed = true;
    vm.initialized = false;
    message = (phase === "error" ? message + " " : "") + error.message + " Обновите страницу.";
    phase = "error";
  }
  clearTimeout(vm.timer);
  await vm.diskWrite?.catch(() => {});
  vm.disk?.close();
  screen.hidden = true;
  screen.firstElementChild.replaceChildren();
  screen.lastElementChild.style.display = "none";
  $("inputHint").textContent = "Консоль появится после включения";
  if (!vm.cleanupFailed) session = null;
  renderProfile();
  render(phase, message);
}

function fail(vm, error) {
  if (session !== vm || vm.closing) return;
  console.error(error);
  return closeSession(vm, "error", error.message || String(error));
}

async function start() {
  if (session) return;
  const kind = $("profile").value;
  const profile = profiles[kind];
  const memorySize = Number($("memory").value) * MiB;
  if (location.protocol === "file:") {
    render("error", "Откройте страницу через локальный HTTP-сервер. Инструкции есть в README.");
    return;
  }
  if (typeof V86 !== "function" || (profile.serial && (typeof Terminal !== "function" || !globalThis.FitAddon))) {
    render("error", "Библиотеки v86 или терминала не найдены. Запустите scripts/setup.sh или setup.ps1.");
    return;
  }

  const vm = session = {
    kind, profile, hasVga: profile.desktop || !profile.serial,
    downloads: new AbortController(), bytes: [], line: "", diskLine: "", diskSequence: 0, frame: 0,
  };
  const files = { wasm: "v86.wasm", bios: "seabios.bin", vga_bios: "vgabios.bin", ...profile.files };
  progress.max = Object.keys(files).length + Number(Boolean(profile.disk));
  progress.value = 0;
  render("loading", "Читаем WebAssembly, BIOS и загрузочный образ.");
  vm.timer = setTimeout(() => {
    vm.finishHardware?.(true);
    void fail(vm, new Error("v86 не инициализировался за 45 секунд."));
  }, 45_000);

  try {
    const assets = await Promise.all(Object.entries(files).map(async ([key, name]) => [key, await loadAsset(name, vm)]));
    if (session !== vm || vm.closing) return;
    const { wasm: wasmBytes, ...images } = Object.fromEntries(assets);
    if (images.initrd && initrdOffset + images.initrd.byteLength > memorySize) {
      throw new Error("Архив initramfs не помещается в память. Увеличьте объём RAM и запустите VM снова.");
    }
    if (profile.disk) {
      const disk = await openNexaDisk(() => loadAsset("nexa-data.ext4", vm), vm.downloads.signal);
      if (session !== vm || vm.closing) {
        disk.close();
        return;
      }
      vm.disk = disk;
      images.hda = disk.buffer;
      if (disk.restored) progress.value += 1;
    }
    const wasm = await WebAssembly.compile(wasmBytes);
    if (session !== vm || vm.closing) return;

    if (profile.serial) openTerminal(vm);
    showDisplay(vm, vm.hasVga);

    vm.hardware = new Promise(resolve => { vm.finishHardware = resolve; });
    try {
      vm.emulator = new V86({
        wasm_fn: async imports => {
          try {
            return new WebAssembly.Instance(wasm, imports).exports;
          } catch (error) {
            vm.finishHardware(false);
            throw error;
          }
        },
        memory_size: memorySize,
        autostart: false,
        uart1: Boolean(profile.disk),
        disable_speaker: true,
        disable_keyboard: !vm.hasVga,
        disable_mouse: !vm.hasVga,
        screen_container: vm.hasVga ? screen : undefined,
        cmdline: profile.cmdline,
        ...Object.fromEntries(Object.entries(images).map(([key, buffer]) => [key, { buffer }])),
      });
    } catch (error) {
      vm.finishHardware(false);
      throw error;
    }
    vm.emulator.add_listener("emulator-ready", () => {
      vm.finishHardware(true);
      launchGuest(vm);
    });
    if (profile.serial) vm.emulator.add_listener("serial0-output-byte", byte => serialByte(vm, byte));
    if (profile.disk) vm.emulator.add_listener("serial1-output-byte", byte => diskByte(vm, byte));
  } catch (error) {
    await fail(vm, error);
  }
}

$("start").addEventListener("click", start);
$("off").addEventListener("click", () => { void powerAction(false); });
$("reset").addEventListener("click", () => { void powerAction(true); });
$("forceOff").addEventListener("click", () => {
  if (session?.saveFailed && !session.saving) {
    void closeSession(session, "off", "VM выключена. Диск остался на последней сохранённой версии.");
  }
});

window.addEventListener("beforeunload", event => {
  if (diskMayBeMounted(session) && !session.closing) {
    event.preventDefault();
    event.returnValue = "";
  }
});

$("profile").addEventListener("change", renderProfile);
$("switchDisplay").addEventListener("click", () => {
  if (session?.initialized && session.profile.desktop) showDisplay(session, screen.hidden);
});
$("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement === machine) await document.exitFullscreen();
    else await machine.requestFullscreen();
  } catch (error) {
    $("message").textContent = "Полноэкранный режим недоступен. " + error.message;
  }
});
document.addEventListener("fullscreenchange", () => {
  const label = document.fullscreenElement === machine ? "Выйти из полноэкранного режима" : "Полноэкранный режим";
  $("fullscreen").setAttribute("aria-label", label);
  $("fullscreen").title = label;
});

screen.addEventListener("focus", () => {
  if (session?.initialized && !session.closing) {
    session.emulator.keyboard_set_enabled(true);
    session.emulator.mouse_set_enabled(true);
  }
});
screen.addEventListener("blur", () => {
  if (session?.initialized && !session.closing) {
    session.emulator.keyboard_set_enabled(false);
    session.emulator.mouse_set_enabled(false);
  }
});
machine.addEventListener("keydown", event => {
  const leaveVga = screen.contains(event.target) && event.code === "F6" &&
    !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  const leaveTerminal = terminalHost.contains(event.target) && event.ctrlKey && event.code === "BracketRight";
  if (leaveVga || leaveTerminal) {
    event.preventDefault();
    event.stopPropagation();
    $("fullscreen").focus();
  }
}, true);

function reportEmulatorError(error, source = "") {
  if (!session) return;
  if (source.includes("/assets/libv86.js") || error.stack?.includes("/assets/libv86.js") ||
      error instanceof WebAssembly.LinkError || error instanceof WebAssembly.RuntimeError) {
    session.finishHardware?.(true);
    void fail(session, error);
  }
}

window.addEventListener("unhandledrejection", event => {
  if (event.reason instanceof Error) reportEmulatorError(event.reason);
});
window.addEventListener("error", event => {
  reportEmulatorError(event.error || new Error(event.message), event.filename);
});

renderProfile();
render("off", "Выберите образ и включите виртуальную машину.");
