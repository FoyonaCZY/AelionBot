async page => {
 await page.setViewportSize({width:1400,height:900});await page.emulateMedia({reducedMotion:'reduce'});
 const captures=[];
 for(const lang of ['zh-CN','zh-TW','en'])for(const shot of ['workspace','conversation','collaboration','studio','computer','handoff','rhythm','designer']){
  await page.goto('http://127.0.0.1:4173/tools/product-capture/?lang='+lang+'&shot='+shot);
  await page.locator('.app-shell').waitFor({timeout:15000});
  if(shot==='collaboration'){await page.locator('[data-group-id="research-group"]').click();await page.locator('.group-message').first().waitFor();}
  if(shot==='studio'){await page.locator('.attachment-open').first().click();await page.locator('.fp-panel').waitFor();}
  if(shot==='computer'){await page.locator('.computer-panel-settings').click();await page.locator('.settings-modal').waitFor();}
  if(shot==='handoff'){await page.locator('.peer-notice-open').click();await page.locator('.peer-message').first().waitFor();}
  if(shot==='rhythm'){await page.locator('.bot-heading').click();await page.locator('.bot-profile-types').waitFor();}
  if(shot==='designer'){await page.locator('.designer-system-control button').click();await page.locator('.designer-system-dialog').waitFor();}
  await page.evaluate(()=>document.fonts.ready);await page.mouse.move(1398,898);
  await page.screenshot({path:'docs/assets/screenshots/'+shot+'-'+lang+'.png',animations:'disabled'});
  captures.push({lang,shot});
 }
 return captures;
}
