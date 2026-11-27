export interface DjiCameraModelSpec {
  modelId: number;
  modelName: string;
  blePrefixes: string[];
  datalinkPort: number;
  tcpPoke: boolean;
  wifiSecurity: 'WPA2' | 'WPA3';
  singleInternalStore?: boolean;
  supportedForOffload: boolean;
  notes?: string;
}

export const DJI_COMPANY_IDS = new Set([0x08aa, 0xaa08]);
export const XTRA_COMPANY_IDS = new Set([0xaaf7, 0xf7aa]);

export const DJI_MODEL_SPECS: DjiCameraModelSpec[] = [
  {
    modelId: 0x0022,
    modelName: 'Osmo Pocket 4 Pro',
    blePrefixes: ['OsmoPocket4P'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
  },
  {
    modelId: 0x0021,
    modelName: 'Osmo Pocket 4',
    blePrefixes: ['OsmoPocket4'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
  },
  {
    modelId: 0x0020,
    modelName: 'Osmo Pocket 3',
    blePrefixes: ['OsmoPocket3'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
  },
  {
    modelId: 0x0019,
    modelName: 'Osmo Nano',
    blePrefixes: ['OsmoNano'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    singleInternalStore: true,
    supportedForOffload: true,
  },
  {
    modelId: 0x0018,
    modelName: 'Osmo Action 6',
    blePrefixes: ['OsmoAction6'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
  },
  {
    modelId: 0x0015,
    modelName: 'Osmo Action 5 Pro',
    blePrefixes: ['OsmoAction5Pro', 'OsmoAction5'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
  },
  {
    modelId: 0x0014,
    modelName: 'Osmo Action 4',
    blePrefixes: ['OsmoAction4'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
  },
  {
    modelId: 0x0012,
    modelName: 'Osmo Action 3',
    blePrefixes: ['OsmoAction3'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
    notes: 'Unconfirmed firmware variant; falls back to standard 9004 + poke.',
  },
  {
    modelId: 0x0010,
    modelName: 'Osmo Action 2',
    blePrefixes: ['OsmoAction2'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
    notes: 'Unconfirmed firmware variant; falls back to standard 9004 + poke.',
  },
  {
    modelId: 0x0006,
    modelName: 'Osmo Action',
    blePrefixes: ['OsmoAction'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA2',
    supportedForOffload: true,
    notes: 'Legacy index-based media list.',
  },
  {
    modelId: 0x0017,
    modelName: 'Osmo 360',
    blePrefixes: ['Osmo360'],
    datalinkPort: 9004,
    tcpPoke: true,
    wifiSecurity: 'WPA3',
    supportedForOffload: false,
    notes: 'Uses WPA3 / fff7 and AP datalink is currently unconfirmed upstream.',
  },
];

const NEW_ADVERT_PRODUCT_TYPES: Record<number, { modelId: number; modelName: string }> = {
  218: { modelId: 0x0022, modelName: 'Osmo Pocket 4 Pro' },
};

export function resolveDjiModel(
  manufacturerData: Record<number, Buffer | Uint8Array>,
  localName: string
): { modelId: number | null; modelName: string; spec?: DjiCameraModelSpec } {
  for (const [rawCid, payload] of Object.entries(manufacturerData)) {
    const cid = Number(rawCid);
    if (!DJI_COMPANY_IDS.has(cid) && !XTRA_COMPANY_IDS.has(cid)) continue;
    if (payload.length >= 12) {
      const ptype = payload[10] | (payload[11] << 8);
      const newSpec = NEW_ADVERT_PRODUCT_TYPES[ptype];
      if (newSpec) {
        const spec = DJI_MODEL_SPECS.find((s) => s.modelId === newSpec.modelId);
        return { modelId: newSpec.modelId, modelName: newSpec.modelName, spec };
      }
    }
    if (payload.length >= 1) {
      const id = payload[0];
      if (localName.startsWith('XtraEdgePro')) {
        return {
          modelId: 0x0015,
          modelName: 'Xtra Edge Pro',
          spec: {
            modelId: 0x0015,
            modelName: 'Xtra Edge Pro',
            blePrefixes: ['XtraEdgePro'],
            datalinkPort: 10004,
            tcpPoke: false,
            wifiSecurity: 'WPA2',
            supportedForOffload: true,
          },
        };
      }
      const spec = DJI_MODEL_SPECS.find((s) => s.modelId === id);
      if (spec) return { modelId: id, modelName: spec.modelName, spec };
    }
  }

  if (localName.startsWith('XtraEdgePro')) {
    return {
      modelId: 0x0015,
      modelName: 'Xtra Edge Pro',
      spec: {
        modelId: 0x0015,
        modelName: 'Xtra Edge Pro',
        blePrefixes: ['XtraEdgePro'],
        datalinkPort: 10004,
        tcpPoke: false,
        wifiSecurity: 'WPA2',
        supportedForOffload: true,
      },
    };
  }

  for (const spec of DJI_MODEL_SPECS) {
    if (spec.blePrefixes.some((p) => localName.startsWith(p))) {
      return { modelId: spec.modelId, modelName: spec.modelName, spec };
    }
  }
  return { modelId: null, modelName: localName || 'Unknown DJI Camera' };
}
