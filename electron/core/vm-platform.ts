import {join} from 'node:path';
import {existsSync} from 'node:fs';
import x64Image from '../../runtime/guest-image.json';
import armImage from '../../runtime/guest-image-arm64.json';
export type GuestArch='x64'|'arm64';
export function vmPlatform(platform:NodeJS.Platform=process.platform,arch:string=process.arch){
 if(!['x64','arm64'].includes(arch)||platform==='win32'&&arch!=='x64')throw Error('此操作系统与 CPU 组合尚未提供工作电脑运行时');
 const guestArch=arch as GuestArch;
 return {arch:guestArch,image:guestArch==='arm64'?armImage:x64Image,accelerator:platform==='darwin'?'hvf':platform==='win32'?'whpx':'tcg',executable:`qemu-system-${guestArch==='arm64'?'aarch64':'x86_64'}${platform==='win32'?'.exe':''}`,imageTool:`qemu-img${platform==='win32'?'.exe':''}`,machine:guestArch==='arm64'?'virt':'q35'};
}
export function qemuBinary(runtimeDir:string,name:string){const direct=join(runtimeDir,name);return existsSync(direct)||name.endsWith('.exe')?direct:join(runtimeDir,'bin',name);}
export const qemuDataDir=(runtimeDir:string)=>existsSync(join(runtimeDir,'share','qemu'))?join(runtimeDir,'share','qemu'):join(runtimeDir,'share');
export function qemuFirmware(runtimeDir:string,name:string){for(const folder of ['share','share/qemu']){const file=join(runtimeDir,folder,name);if(existsSync(file))return file;}throw Error(`工作电脑固件缺失：${name}`);}
export function vmMachineArgs(profile:ReturnType<typeof vmPlatform>,runtimeDir:string,varsFile:string,accelerator=profile.accelerator){
 if(profile.arch==='arm64')return ['-machine','virt','-accel',accelerator,'-cpu',accelerator==='tcg'?'cortex-a72':'host','-drive',`if=pflash,format=raw,readonly=on,file=${qemuFirmware(runtimeDir,'edk2-aarch64-code.fd').replaceAll(',',',,')}`,'-drive',`if=pflash,format=raw,file=${varsFile.replaceAll(',',',,')}`,'-device','virtio-gpu-pci'];
 return ['-machine','q35','-accel',accelerator,...(accelerator==='hvf'?['-cpu','host']:accelerator==='tcg'?['-cpu','max']:[]),'-vga','virtio'];
}
