import test from 'node:test';
import assert from 'node:assert/strict';
import {detectDownloadPlatform,recommendDownload,downloadHref,downloadIcon,downloadBuilds} from '../src/download-platform.mjs';

const repo='https://github.com/FoyonaCZY/AelionBot';
const version='0.20.0';

test('Chrome Windows x64 is recommended the Windows installer',()=>{
  const platform=detectDownloadPlatform({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
    platform:'Win32',
    userAgentData:{platform:'Windows',mobile:false,architecture:'x86',bitness:'64'},
  });
  assert.deepEqual(platform,{os:'windows',arch:'x64'});
  assert.deepEqual(recommendDownload(platform),{primary:'windows-x64',alternatives:['mac-arm64','mac-x64']});
  assert.equal(downloadHref('windows-x64',repo,version),`${repo}/releases/download/v0.20.0/AelionBot-Setup-0.20.0-x64.exe`);
  assert.equal(downloadIcon('windows-x64'),'windows');
});

test('Windows ARM still gets the x64 installer because that is the shipped Windows build',()=>{
  const platform=detectDownloadPlatform({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
    platform:'Win32',
    userAgentData:{platform:'Windows',mobile:false,architecture:'arm',bitness:'64'},
  });
  assert.equal(platform.os,'windows');
  assert.equal(platform.arch,'arm64');
  assert.equal(recommendDownload(platform).primary,'windows-x64');
});

test('Mac Apple Silicon from client hints gets the ARM disk image',()=>{
  const platform=detectDownloadPlatform({
    userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
    platform:'MacIntel',
    userAgentData:{platform:'macOS',mobile:false,architecture:'arm',bitness:'64'},
  });
  assert.deepEqual(platform,{os:'mac',arch:'arm64'});
  const rec=recommendDownload(platform);
  assert.equal(rec.primary,'mac-arm64');
  assert.deepEqual(rec.alternatives,['windows-x64','mac-x64']);
  assert.equal(downloadHref(rec.primary,repo,version),`${repo}/releases/download/v0.20.0/AelionBot-0.20.0-mac-arm64.dmg`);
  assert.equal(downloadIcon(rec.primary),'mac');
});

test('Mac Intel from client hints gets the Intel disk image',()=>{
  const platform=detectDownloadPlatform({
    userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
    platform:'MacIntel',
    userAgentData:{platform:'macOS',mobile:false,architecture:'x86',bitness:'64'},
  });
  assert.deepEqual(platform,{os:'mac',arch:'x64'});
  assert.equal(recommendDownload(platform).primary,'mac-x64');
  assert.equal(downloadHref('mac-x64',repo,version),`${repo}/releases/download/v0.20.0/AelionBot-0.20.0-mac-x64.dmg`);
});

test('Safari on Apple Silicon uses the WebGL renderer because the UA still says MacIntel',()=>{
  const hints={
    userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    platform:'MacIntel',
  };
  assert.equal(recommendDownload(detectDownloadPlatform({...hints,webglRenderer:'Apple GPU'})).primary,'mac-arm64');
  assert.equal(recommendDownload(detectDownloadPlatform({...hints,webglRenderer:'Apple M3 Pro'})).primary,'mac-arm64');
  assert.equal(recommendDownload(detectDownloadPlatform({...hints,webglRenderer:'Intel Iris Plus Graphics'})).primary,'mac-x64');
  assert.equal(recommendDownload(detectDownloadPlatform(hints)).primary,'mac-x64','unknown Mac prefers Intel because that disk image also runs on Apple Silicon via Rosetta');
});

test('phones, tablets, Linux and unknown browsers are not offered a Windows installer as the main button',()=>{
  const cases=[
    {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',platform:'iPhone'},
    {userAgent:'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',platform:'iPad'},
    {userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',platform:'MacIntel',maxTouchPoints:5},
    {userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36',platform:'Linux armv8l'},
    {userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',platform:'Linux x86_64'},
    {userAgent:'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',platform:'Linux x86_64'},
    {},
  ];
  for(const hints of cases){
    const rec=recommendDownload(detectDownloadPlatform(hints));
    assert.equal(rec.primary,'releases',JSON.stringify(hints));
    assert.deepEqual(rec.alternatives,[...downloadBuilds]);
  }
  assert.equal(downloadHref('releases',repo,version),`${repo}/releases/latest`);
  assert.equal(downloadIcon('releases'),'down');
});

test('Windows UA without client hints still resolves to the x64 installer',()=>{
  const platform=detectDownloadPlatform({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    platform:'Win32',
  });
  assert.deepEqual(platform,{os:'windows',arch:'x64'});
  assert.equal(recommendDownload(platform).primary,'windows-x64');
});
