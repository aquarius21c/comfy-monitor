const GB = 1024 ** 3

export const SYSTEM_STATS = JSON.stringify({
  system: { os: 'nt', ram_total: 64 * GB, ram_free: 40 * GB, comfyui_version: '0.39.2' },
  devices: [
    {
      name: 'cuda:0 NVIDIA GeForce RTX 5080 : cudaMallocAsync',
      type: 'cuda',
      vram_total: 16 * GB,
      vram_free: 6 * GB,
      torch_vram_total: 8 * GB,
      torch_vram_free: 1 * GB,
    },
  ],
})
