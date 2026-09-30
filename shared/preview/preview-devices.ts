type PreviewScheme = 'light' | 'dark';
export interface PreviewDevice {
  name: string;
  width: number;
  height: number;
  /** undefined follows the page's own default. */
  scheme?: PreviewScheme;
}
export interface PreviewDevicePreset {
  id: string;
  label: string;
  primary: PreviewDevice;
  /** A second, read-only device shown beside the first. */
  mirror?: PreviewDevice;
}

const pixel = { name: 'Pixel 8', width: 412, height: 915 },
  iphone = { name: 'iPhone 16', width: 393, height: 852 };

export const PREVIEW_DEVICE_PRESETS: PreviewDevicePreset[] = [
  { id: 'pixel', label: 'Pixel 8 · 412', primary: pixel },
  { id: 'iphone', label: 'iPhone 16 · 393', primary: iphone },
  { id: 'pixel-dark', label: 'Pixel 8 · 深色', primary: { ...pixel, scheme: 'dark' } },
  {
    id: 'pair-scheme',
    label: '并排：浅色 + 深色',
    primary: { ...pixel, scheme: 'light' },
    mirror: { ...pixel, scheme: 'dark' },
  },
  { id: 'pair-devices', label: '并排：Pixel 8 + iPhone 16', primary: pixel, mirror: iphone },
];

export const previewDevicePreset = (id: string | null | undefined) =>
  PREVIEW_DEVICE_PRESETS.find((preset) => preset.id === id) || PREVIEW_DEVICE_PRESETS[0];

/** Caption under each device frame, for example "iPhone 16 · 393 · 深色". */
export const previewDeviceCaption = (device: PreviewDevice, dark: string, light: string) =>
  [device.name, String(device.width), device.scheme === 'dark' ? dark : device.scheme === 'light' ? light : '']
    .filter(Boolean)
    .join(' · ');
