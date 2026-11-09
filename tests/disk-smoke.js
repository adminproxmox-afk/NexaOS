async page => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  const serial = "#terminal .xterm-rows";
  const token = "disk-" + Date.now();
  const name = ".nexa-test-" + token;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const phase = async (target, expected) => {
    const state = await target.waitForFunction(expected => {
      const current = document.querySelector("#machine").dataset.phase;
      if (current === expected || current === "error" || current === "timeout") return current;
    }, expected, { timeout: 90_000 });
    check(await state.jsonValue() === expected, await target.locator("#message").innerText());
  };
  const output = async pattern => {
    try {
      await page.waitForFunction(({ serial, source, flags }) =>
        new RegExp(source, flags).test(document.querySelector(serial)?.innerText),
      { serial, source: pattern.source, flags: pattern.flags }, { timeout: 12_000 });
    } catch (error) {
      throw new Error("Expected " + pattern + "\n" + await page.locator(serial).innerText(), { cause: error });
    }
  };
  const command = async text => {
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  const login = async () => {
    await phase(page, "ready");
    await output(/nexaos login:/);
    await page.locator("#terminal .xterm").click();
    await command("user");
    await output(/^\$\s*$/m);
  };

  await page.locator("#profile").selectOption("custom");
  await page.locator("#start").click();
  await login();
  await command("mount | grep 'on /home/user type ext4'");
  await output(/^\/dev\/sda on \/home\/user type ext4 \(rw,/m);

  const otherTab = await page.context().newPage();
  try {
    await otherTab.goto(page.url());
    await otherTab.locator("#profile").selectOption("custom");
    await otherTab.locator("#start").click();
    await phase(otherTab, "error");
    check((await otherTab.locator("#message").innerText()).includes("другой вкладке"), "Second writer was not refused");
  } finally {
    await otherTab.close();
  }

  await page.locator("#terminal .xterm").click();
  await command("echo " + token + " > " + name + "; cat " + name);
  await output(new RegExp("^" + token + "\\s*$", "m"));
  await command("touch /tmp/" + name + "; echo TEMP_READY");
  await output(/^TEMP_READY\s*$/m);
  await command("exec 3>>" + name + "; echo DESCRIPTOR_OPEN");
  await output(/^DESCRIPTOR_OPEN\s*$/m);

  // A failed IndexedDB write must leave the guest available for a retry.
  await page.evaluate(() => {
    const prototype = IDBObjectStore.prototype;
    const put = prototype.put;
    prototype.put = function (...args) {
      if (this.name !== "disks") return put.apply(this, args);
      prototype.put = put;
      throw new DOMException("Injected write failure", "QuotaExceededError");
    };
  });
  await page.locator("#off").click();
  await phase(page, "error");
  check(await page.locator("#forceOff").isVisible(), "Save failure did not expose the explicit discard action");
  await page.locator("#terminal .xterm").click();
  await command("echo THAW_OK > " + name + ".retry && cat " + name + ".retry");
  await output(/^THAW_OK\s*$/m);

  await page.locator("#off").click();
  await phase(page, "off");
  check((await page.locator("#message").innerText()).includes("Диск сохранён"), "Shutdown did not confirm persistence");

  await page.reload();
  await page.locator("#start").click();
  await login();
  await command("cat " + name);
  await output(new RegExp("^" + token + "\\s*$", "m"));
  await command("test ! -e /tmp/" + name + " && echo RAM_RESET");
  await output(/^RAM_RESET\s*$/m);
  await command("rm " + name + " " + name + ".retry; echo CLEANED");
  await output(/^CLEANED\s*$/m);
  await page.locator("#reset").click();
  await login();
  await command("test ! -e " + name + " && echo DELETION_SAVED");
  await output(/^DELETION_SAVED\s*$/m);
  await page.locator("#off").click();
  await phase(page, "off");
  return { persistedAfterReload: token, temporaryFileGone: true, concurrentWriterRefused: true,
    recoveredFromWriteFailure: true, deletionSavedOnRestart: true };
}
