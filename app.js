"use strict";

const $ = id => document.getElementById(id);
const profiles = {
  custom: {
    serial: true,
    files: { bzimage: "bzImage", initrd: "rootfs.cpio.gz" },
    cmdline: "console=tty0 console=ttyS0,115200 rdinit=/init tsc=reliable mitigations=off",
    hint: "Linux i686 и BusyBox. Для входа введите user.",
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

const labels = {
  off: "Выключена",
  loading: "Подготовка к запуску",
  booting: "Загрузка Linux",
  ready: "Linux готов",
  running: "Эмуляция активна",
  timeout: "Ожидание Linux",
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
  $("off").disabled = !session || session.closing;
  $("reset").disabled = !session?.initialized || session.closing;
}

function renderProfile() {
  const profile = profiles[$("profile").value];
  const memory = $("memory");
  memory.querySelector('option[value="64"]').disabled = Boolean(profile.files.initrd);
  if (profile.files.initrd && memory.value === "64") memory.value = "128";
  $("profileHint").textContent = profile.hint;
  $("consoleTitle").textContent = profile.serial ? "Последовательная консоль" : "Экран гостевой системы";
  $("consoleTag").textContent = profile.serial ? "TTY / COM1" : "VGA";
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
    const setup = name === "bzImage" || name === "rootfs.cpio.gz" ? "build-linux.sh" : "setup.sh или setup.ps1";
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
    if (session === vm && vm.initialized && !vm.closing) vm.emulator.serial_send_bytes(0, encoder.encode(data));
  });
  $("inputHint").textContent = "Нажмите на терминал для ввода · Ctrl+] возвращает фокус к управлению";
}

function ready(vm) {
  if (session !== vm || vm.closing || vm.ready) return;
  vm.ready = true;
  clearTimeout(vm.timer);
  render("ready", vm.profile.serial ? "NexaOS запущена. Введите user и нажмите Enter." : "Гостевая оболочка ISO готова к вводу.");
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
  if (vm.banner && vm.line === "nexaos login:") ready(vm);
  if (vm.line.endsWith("Kernel panic - not syncing")) reportPanic(vm);
}

function reportPanic(vm) {
  clearTimeout(vm.timer);
  clearInterval(vm.vgaPoll);
  render("error", "Ядро Linux остановилось. Подробности остались в консоли.");
}

function launchGuest(vm) {
  vm.initialized = true;
  clearTimeout(vm.timer);
  if (vm.closing) return;
  if (!vm.profile.serial) {
    vm.emulator.keyboard_set_enabled(document.activeElement === screen);
    vm.emulator.mouse_set_enabled(document.activeElement === screen);
  }

  if (vm.kind === "legacy") {
    render("running", "Проверьте вывод VGA. Для этого образа нет автоматической проверки готовности.");
  } else {
    render("booting", "v86 запущен. Ожидаем приглашение гостевой системы.");
    vm.timer = setTimeout(() => {
      if (session === vm && !vm.closing && !vm.ready) {
        render("timeout", "Приглашение не появилось за 180 секунд. Проверьте вывод консоли.");
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
  screen.hidden = true;
  screen.firstElementChild.replaceChildren();
  screen.lastElementChild.style.display = "none";
  $("inputHint").textContent = "Консоль появится после включения";
  if (!vm.cleanupFailed) session = null;
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
    kind, profile, downloads: new AbortController(), bytes: [], line: "", frame: 0,
  };
  const files = { wasm: "v86.wasm", bios: "seabios.bin", vga_bios: "vgabios.bin", ...profile.files };
  progress.max = Object.keys(files).length;
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
    const wasm = await WebAssembly.compile(wasmBytes);
    if (session !== vm || vm.closing) return;

    if (profile.serial) openTerminal(vm);
    else {
      screen.hidden = false;
      $("inputHint").textContent = "Нажмите на VGA для ввода · F6 возвращает фокус к управлению";
    }

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
        disable_speaker: true,
        disable_keyboard: Boolean(profile.serial),
        disable_mouse: Boolean(profile.serial),
        screen_container: profile.serial ? undefined : screen,
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
  } catch (error) {
    await fail(vm, error);
  }
}

$("start").addEventListener("click", start);
$("off").addEventListener("click", () => {
  if (session) void closeSession(session, "off", "Виртуальная машина выключена. Содержимое RAM сброшено.");
});
$("reset").addEventListener("click", async () => {
  if (!session?.initialized || session.closing) return;
  await closeSession(session, "off", "Перезапускаем виртуальную машину.");
  if (machine.dataset.phase === "off") await start();
});

$("profile").addEventListener("change", renderProfile);
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
