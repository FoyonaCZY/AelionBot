import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DESKTOP_SCRIPT,GUEST_IMAGE_SEAL_SCRIPT,PROVISIONED_WORKSTATION_PATH,WORKSTATION_VERSION} from '../electron/core/desktop-profile';
import {provisionGuestImage} from '../scripts/provision-guest-image';
import x64Image from '../runtime/guest-image.json';
import armImage from '../runtime/guest-image-arm64.json';

test('desktop setup skips APT when a matching provisioned guest image is present',()=>{
 assert.equal(PROVISIONED_WORKSTATION_PATH,'/var/lib/aelion/provisioned-workstation');
 assert.match(DESKTOP_SCRIPT,new RegExp(`provisioned=\\$\\(cat ${PROVISIONED_WORKSTATION_PATH}`));
 assert.match(DESKTOP_SCRIPT,new RegExp(`provisioned" = '${WORKSTATION_VERSION}'`));
 assert.match(DESKTOP_SCRIPT,/printf provisioned > \/var\/lib\/aelion\/desktop-stage/);
 assert.match(DESKTOP_SCRIPT,/Guest image already contains workstation/);
 assert.match(DESKTOP_SCRIPT,/aelion-packages desktop/);
 assert.match(DESKTOP_SCRIPT,/command -v unzip/);assert.match(DESKTOP_SCRIPT,/command -v pdftotext/);assert.match(DESKTOP_SCRIPT,/command -v ibus/);
});

test('sealing a provisioned image keeps packages and forces the next cloud-init',()=>{
 assert.match(GUEST_IMAGE_SEAL_SCRIPT,new RegExp(`${PROVISIONED_WORKSTATION_PATH}`));
 assert.match(GUEST_IMAGE_SEAL_SCRIPT,new RegExp(`printf '${WORKSTATION_VERSION}' > ${PROVISIONED_WORKSTATION_PATH}`));
 assert.match(GUEST_IMAGE_SEAL_SCRIPT,/cloud-init clean --logs --machine-id/);
 assert.match(GUEST_IMAGE_SEAL_SCRIPT,/rm -rf \/home\/aelion\/\.ssh \/root\/\.ssh/);
 assert.doesNotMatch(GUEST_IMAGE_SEAL_SCRIPT,/apt-get|aelion-packages/);
});

test('guest image provisioning refuses TCG unless it is explicitly forced',async()=>{
 const previousAccel=process.env.AELION_ACCELERATOR,previousTcg=process.env.AELION_PROVISION_TCG;
 process.env.AELION_ACCELERATOR='tcg';delete process.env.AELION_PROVISION_TCG;
 try{await assert.rejects(()=>provisionGuestImage(),/HVF, WHPX, or KVM/);}
 finally{
  if(previousAccel===undefined)delete process.env.AELION_ACCELERATOR;else process.env.AELION_ACCELERATOR=previousAccel;
  if(previousTcg===undefined)delete process.env.AELION_PROVISION_TCG;else process.env.AELION_PROVISION_TCG=previousTcg;
 }
});

test('shipped guest images stay official Debian clouds and are not packed into the app installer',()=>{
 for(const image of [x64Image,armImage]){
  assert.equal('provisionedWorkstation' in image,false);
  assert.match(image.url,/cloud\.debian\.org/);
  assert.match(image.filename,/genericcloud/);
 }
 const pack=JSON.parse(readFileSync('package.json','utf8'));
 const resources=[...pack.build.win.extraResources,...(pack.build.mac?.extraResources||[])];
 assert.ok(resources.every((item:{from:string})=>!/guest-image|\.qcow2/.test(item.from)));
 assert.match(readFileSync('scripts/package-macos-release.mjs','utf8'),/extraResources:\[\{from:'runtime\/qemu'/);
 assert.doesNotMatch(readFileSync('scripts/package-macos-release.mjs','utf8'),/\.qcow2/);
 assert.match(readFileSync('scripts/package-macos-release.mjs','utf8'),/Packaged QEMU HVF support missing/);
 assert.match(readFileSync('scripts/verify-macos-vm.ts','utf8'),/AELION_ALLOW_TCG_SMOKE/);
 assert.match(readFileSync('scripts/provision-guest-image.ts','utf8'),/Do not copy it into electron-builder extraResources/);
});
