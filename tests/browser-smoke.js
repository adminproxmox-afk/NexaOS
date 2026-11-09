async page => {
  const phase = async name => {
    try {
      const actual = await page.waitForFunction(expected => {
        const state = document.querySelector("#machine").dataset.phase;
        if (state === expected || state === "error" || state === "timeout") return state;
      }, name, { timeout: name === "ready" ? 185_000 : 15_000 });
      if (await actual.jsonValue() !== name) throw new Error("Unexpected guest state");
    } catch (error) {
      throw new Error("Waiting for " + name + ": " + await page.locator("#message").innerText(), { cause: error });
    }
  };
  const output = async (selector, pattern) => {
    try {
      await page.waitForFunction(({ selector, source, flags }) => {
        const element = document.querySelector(selector);
        return element && new RegExp(source, flags).test(element.innerText);
      }, { selector, source: pattern.source, flags: pattern.flags }, { timeout: 15_000 });
    } catch (error) {
      throw new Error("Guest output did not match " + pattern + "\n" + await page.locator(selector).innerText(), { cause: error });
    }
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const command = async text => {
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  const serial = "#terminal .xterm-rows";
  const vga = ".vga-text";
  const results = {};

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.locator("#profile").selectOption("custom");
  check(await page.locator('#memory option[value="64"]').isDisabled(), "Direct initramfs cannot fit in 64 MiB");
  await page.locator("#memory").selectOption("256");

  const image = "**/assets/bzImage";
  await page.route(image, route => route.fulfill({ status: 404, body: "Missing kernel" }));
  await page.locator("#start").click();
  await phase("error");
  check((await page.locator("#message").innerText()).includes("bzImage"), "Missing kernel error was not reported");
  await page.unroute(image);

  await page.locator("#start").click();
  await phase("ready");
  await output(serial, /Boot completed successfully\./);
  await output(serial, /nexaos login:/);
  await page.locator("#terminal .xterm").click();
  await command("user");
  await output(serial, /^\$\s*$/m);
  await command("id; uname -a; pwd");
  await output(serial, /^uid=1000\(user\)/m);
  await output(serial, /^Linux nexaos 6\.12\.27-nexaos .* i686 GNU\/Linux/m);
  await output(serial, /^\/home\/user\s*$/m);
  results.identity = await page.locator(serial).innerText();

  await command("echo DIR_START; ls -1 /; echo DIR_END");
  await output(serial, /^DIR_END\s*$/m);
  const listing = (await page.locator(serial).innerText()).match(/^DIR_START\s*\n([\s\S]*?)^DIR_END/m)?.[1] || "";
  const entries = new Set(listing.trim().split(/\s+/));
  for (const directory of ["bin", "boot", "dev", "etc", "home", "lib", "proc", "root", "sbin", "sys", "tmp", "usr", "var"]) {
    check(entries.has(directory), "Missing guest directory /" + directory);
  }
  await command("mkdir /tmp/probe; echo persisted-in-ram > /tmp/probe/file");
  await command("cat /tmp/probe/file /etc/os-release /proc/1/comm");
  await output(serial, /^persisted-in-ram\s*$/m);
  await output(serial, /^ID=nexaos\s*$/m);
  await output(serial, /^init\s*$/m);
  await command("ps; mount; grep MemTotal /proc/meminfo; test -d /sys/class && echo SYS_OK");
  await output(serial, /^\s*1\s+root\s.*init\s*$/m);
  await output(serial, /^proc on \/proc type proc /m);
  await output(serial, /^sysfs on \/sys type sysfs /m);
  await output(serial, /^devtmpfs on \/dev type devtmpfs /m);
  await output(serial, /^tmpfs on \/tmp type tmpfs /m);
  await output(serial, /^devpts on \/dev\/pts type devpts /m);
  await output(serial, /^SYS_OK\s*$/m);
  results.system = await page.locator(serial).innerText();
  const memory = Number(results.system.match(/MemTotal:\s*(\d+)/)?.[1]);
  check(memory >= 220_000 && memory < 262_144, "Guest did not receive the selected 256 MiB");

  await page.keyboard.press("Control+]");
  check(await page.locator("#fullscreen").evaluate(button => document.activeElement === button), "Console did not release focus");
  await page.locator("#fullscreen").click();
  await page.waitForFunction(() => document.fullscreenElement?.id === "machine");
  await page.locator("#fullscreen").click();
  await page.waitForFunction(() => document.fullscreenElement === null);

  await page.locator("#reset").click();
  await phase("ready");
  await output(serial, /nexaos login:/);
  await page.locator("#terminal .xterm").click();
  await command("user");
  await output(serial, /^\$\s*$/m);
  await command("test ! -e /tmp/probe/file && echo RAM_RESET");
  await output(serial, /^RAM_RESET\s*$/m);
  await page.locator("#off").click();
  await phase("off");
  check(await page.locator("#terminal").isHidden(), "Terminal was left visible after power-off");
  check(await page.locator("#terminal .xterm").count() === 0, "Terminal was not disposed");

  await page.locator("#profile").selectOption("demo");
  await page.locator("#memory").selectOption("64");
  await page.locator("#start").click();
  await phase("ready");
  await page.locator("#screen_container").focus();
  await page.keyboard.press("F6");
  check(await page.locator("#fullscreen").evaluate(button => document.activeElement === button), "VGA did not release focus");
  await page.locator("#screen_container").focus();
  for (const key of "uname") await page.keyboard.press(key);
  await page.keyboard.press("Enter");
  await output(vga, /^\/root% uname[ \t]*\nLinux[ \t]*$/m);
  results.demo = (await page.locator(vga).innerText()).split("\n").slice(-5).map(line => line.trim());
  await page.locator("#off").click();
  await phase("off");

  await page.locator("#profile").selectOption("legacy");
  check(await page.locator("#memory").inputValue() === "128", "Direct boot did not restore a supported RAM size");
  await page.locator("#start").click();
  await phase("running");
  await output(vga, /Unpacking initramfs\.\.\./);
  await page.locator("#off").click();
  await phase("off");

  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile layout overflowed");
  return results;
}
