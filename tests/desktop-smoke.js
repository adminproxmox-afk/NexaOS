async page => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.reload();
  const serial = "#terminal .xterm-rows";
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const command = async text => {
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  const output = async pattern => {
    await page.waitForFunction(({ serial, source, flags }) =>
      new RegExp(source, flags).test(document.querySelector(serial)?.innerText),
    { serial, source: pattern.source, flags: pattern.flags }, { timeout: 20_000 });
  };

  check(await page.locator('#profile option[value="desktop"]').count() === 1, "NexaDesktop profile is unavailable");
  await page.locator("#profile").selectOption("desktop");
  await page.locator("#memory").selectOption("256");
  await page.locator("#start").click();
  const status = await page.waitForFunction(() => {
    const phase = document.querySelector("#machine").dataset.phase;
    if (["ready", "error", "timeout"].includes(phase)) return phase;
  }, null, { timeout: 185_000 });
  check(await status.jsonValue() === "ready", await page.locator("#message").innerText());
  const canvas = page.locator("#screen_container canvas");
  await canvas.waitFor({ state: "visible" });
  const graphics = await canvas.evaluate(node => ({ width: node.width, height: node.height }));
  check(graphics.width >= 640 && graphics.height >= 480, "Guest did not set a graphics mode");

  await page.locator("#switchDisplay").click();
  await output(/nexaos login:/);
  await page.locator("#terminal .xterm").click();
  await command("user");
  await output(/^\$\s*$/m);
  await command("ps | grep -E '(Xorg|xterm)'");
  await output(/^\s*\d+\s+root\s+.*Xorg/m);
  await output(/^\s*\d+\s+user\s+.*xterm/m);
  await command("grep -i 'modeset(0)' /var/log/Xorg.0.log | head -2");
  await output(/modeset\(0\)/i);
  const guest = await page.locator(serial).innerText();

  await page.locator("#switchDisplay").click();
  await canvas.waitFor({ state: "visible" });
  await page.locator("#off").click();
  await page.waitForFunction(() => document.querySelector("#machine").dataset.phase === "off");
  check((await page.locator("#message").innerText()).includes("Диск сохранён"), "Desktop shutdown did not save ext4");
  return { graphics, guest };
}
