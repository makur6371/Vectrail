import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardPaste, Copy, RotateCcw } from 'lucide-react';
import { Clip, ColorGrade, FadeCurve, Project, TransitionKind, WheelPoint } from '../../shared/types';
import { BUILT_IN_LOOKS } from '../../shared/colorGrade';
import { clipName, formatDB, hexToRgba, rgbaToHex, snapFrame, STANDARD_FPS } from '../../shared/project';
import { retimeClip } from '../../shared/speedRamp';
import { starterZoomMove } from '../../shared/zoomMove';
import { defaultCaptionStyle } from '../../shared/captions';

interface InspectorViewProps {
  project: Project;
  selectedClip?: Clip;
  copiedGrade?: ColorGrade;
  width?: number;
  onUpdateClip: (clipID: string, fn: (c: Clip) => void) => void;
  onUpdateSequence: (fn: (p: Project) => void) => void;
  onCopyGrade: (grade: ColorGrade) => void;
  onFreezeFrame: (clipID: string) => void;
  onReverseClip: (clipID: string) => void;
  onDetachAudio: (clipID: string) => void;
  onTranscribeAll?: () => void;
}

const ColorWheel: React.FC<{
  label: string;
  point: WheelPoint;
  onChange: (pt: WheelPoint) => void;
}> = ({ label, point, onChange }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const updateFromEvent = (clientX: number, clientY: number) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const dx = (clientX - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (clientY - (r.top + r.height / 2)) / (r.height / 2);
    const dist = Math.hypot(dx, dy);
    const clamped = dist > 1 ? { x: dx / dist, y: dy / dist } : { x: dx, y: dy };
    onChange({ x: Math.round(clamped.x * 100) / 100, y: Math.round(clamped.y * 100) / 100 });
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => updateFromEvent(e.clientX, e.clientY);
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        ref={ref}
        className="relative w-16 h-16 rounded-full cursor-crosshair"
        style={{
          background:
            'conic-gradient(from 90deg, #e55, #ee5, #5e5, #5ee, #55e, #e5e, #e55)',
          border: '1px solid var(--stroke)',
        }}
        onMouseDown={(e) => {
          setDragging(true);
          updateFromEvent(e.clientX, e.clientY);
        }}
        onDoubleClick={() => onChange({ x: 0, y: 0 })}
        title={`${label} (double-click to reset)`}
      >
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(22,22,22,0.85) 0%, rgba(22,22,22,0.2) 100%)' }}
        />
        <div
          className="absolute w-2.5 h-2.5 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${50 + point.x * 42}%`,
            top: `${50 + point.y * 42}%`,
            background: '#FFFFFF',
            border: '1.5px solid #000',
          }}
        />
      </div>
      <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
        {label}
      </span>
    </div>
  );
};

const FONT_CHOICES = [
  { label: 'System (Inter / Segoe)', value: '' },
  { label: 'Segoe UI', value: 'Segoe UI' },
  { label: 'Microsoft YaHei', value: 'Microsoft YaHei' },
  { label: 'SimHei', value: 'SimHei' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'Impact', value: 'Impact' },
  { label: 'Times New Roman', value: 'Times New Roman' },
];

const Section: React.FC<{ title: string; right?: React.ReactNode; defaultCollapsed?: boolean; children: React.ReactNode }> = ({
  title,
  right,
  defaultCollapsed = false,
  children,
}) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="py-2.5 px-3" style={{ borderBottom: '1px solid var(--stroke)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: collapsed ? 0 : 8 }}>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-[0.08em]"
          style={{ color: 'var(--text-dim)' }}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          {title}
        </button>
        {right}
      </div>
      {!collapsed && <div className="space-y-2">{children}</div>}
    </div>
  );
};

const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, display, onChange }) => (
  <div className="flex items-center gap-2">
    <span className="w-20 text-[11px] shrink-0" style={{ color: 'var(--text-dim)' }}>
      {label}
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="flex-1"
    />
    <span className="mono-num w-14 shrink-0 whitespace-nowrap text-right text-[11px]" style={{ color: 'var(--text)' }}>
      {display}
    </span>
  </div>
);

export const InspectorView: React.FC<InspectorViewProps> = ({
  project,
  selectedClip,
  copiedGrade,
  width = 296,
  onUpdateClip,
  onUpdateSequence,
  onCopyGrade,
  onFreezeFrame,
  onReverseClip,
  onDetachAudio,
  onTranscribeAll,
}) => {
  const [tab, setTab] = useState<'clip' | 'sequence'>('clip');

  const activeTab = selectedClip ? tab : 'sequence';

  return (
    <div
      data-magic-anchor="inspector"
      className="flex flex-col h-full shrink-0 overflow-y-auto"
      style={{ width, background: 'var(--panel)' }}
    >
      <div
        className="flex items-center justify-between px-3 h-9 shrink-0"
        style={{ borderBottom: '1px solid var(--stroke)' }}
      >
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('clip')}
            disabled={!selectedClip}
            className="px-2 py-0.5 rounded text-[10px] font-semibold tracking-[0.06em]"
            style={{
              background: activeTab === 'clip' ? 'var(--raised)' : 'transparent',
              color: activeTab === 'clip' ? 'var(--text)' : 'var(--text-dim)',
            }}
          >
            CLIP
          </button>
          <button
            onClick={() => setTab('sequence')}
            className="px-2 py-0.5 rounded text-[10px] font-semibold tracking-[0.06em]"
            style={{
              background: activeTab === 'sequence' ? 'var(--raised)' : 'transparent',
              color: activeTab === 'sequence' ? 'var(--text)' : 'var(--text-dim)',
            }}
          >
            SEQUENCE
          </button>
        </div>
        {selectedClip && (
          <span className="truncate max-w-[120px] text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {clipName(project, selectedClip)}
          </span>
        )}
      </div>

      {activeTab === 'sequence' || !selectedClip ? (
        <>
          <Section title="SEQUENCE">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                Width
                <input
                  type="number"
                  value={project.width}
                  onChange={(e) => {
                    const w = Math.max(16, Math.min(8192, Number(e.target.value) || 1920));
                    onUpdateSequence((p) => {
                      p.width = w;
                      p.settingsLocked = true;
                    });
                  }}
                  className="mono-num mt-1 w-full px-2 py-1 rounded text-[11px] outline-none"
                  style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                />
              </label>
              <label className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                Height
                <input
                  type="number"
                  value={project.height}
                  onChange={(e) => {
                    const h = Math.max(16, Math.min(8192, Number(e.target.value) || 1080));
                    onUpdateSequence((p) => {
                      p.height = h;
                      p.settingsLocked = true;
                    });
                  }}
                  className="mono-num mt-1 w-full px-2 py-1 rounded text-[11px] outline-none"
                  style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                />
              </label>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                Frame Rate
              </span>
              <select
                value={project.fps}
                onChange={(e) => {
                  const fps = Number(e.target.value);
                  onUpdateSequence((p) => {
                    p.fps = fps;
                    p.settingsLocked = true;
                  });
                }}
                className="mono-num px-2 py-1 rounded text-[11px] outline-none"
                style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
              >
                {STANDARD_FPS.map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                { label: '16:9 1080p', w: 1920, h: 1080 },
                { label: '16:9 4K', w: 3840, h: 2160 },
                { label: '9:16 Reels', w: 1080, h: 1920 },
                { label: '1:1 Square', w: 1080, h: 1080 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  onClick={() =>
                    onUpdateSequence((p) => {
                      p.width = preset.w;
                      p.height = preset.h;
                      p.settingsLocked = true;
                    })
                  }
                  className="px-2 py-1 rounded text-[10px]"
                  style={{ background: 'var(--button)', color: 'var(--chip)' }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </Section>

          <Section
            title="CAPTIONS"
            right={
              onTranscribeAll && (
                <button
                  onClick={onTranscribeAll}
                  className="px-2 py-0.5 rounded text-[10px]"
                  style={{ background: 'var(--button)', color: 'var(--chip)' }}
                >
                  Transcribe
                </button>
              )
            }
          >
            <label className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-dim)' }}>
              <span>Show Captions</span>
              <input
                type="checkbox"
                checked={Boolean(project.captions && !project.captions.hidden)}
                onChange={(e) =>
                  onUpdateSequence((p) => {
                    if (e.target.checked) {
                      p.captions = p.captions ? { ...p.captions, hidden: false } : defaultCaptionStyle();
                      p.clips.forEach((c) => {
                        if (c.kind === 'audio' || c.kind === 'video') c.captioned = true;
                      });
                    } else if (p.captions) {
                      p.captions.hidden = true;
                    }
                  })
                }
              />
            </label>
            {project.captions && !project.captions.hidden && (
              <>
                <SliderRow
                  label="Size"
                  value={project.captions.size}
                  min={28}
                  max={120}
                  step={2}
                  display={`${Math.round(project.captions.size)}px`}
                  onChange={(v) =>
                    onUpdateSequence((p) => {
                      if (p.captions) p.captions.size = v;
                    })
                  }
                />
                <SliderRow
                  label="Y Pos"
                  value={project.captions.position}
                  min={0.15}
                  max={0.92}
                  step={0.01}
                  display={`${Math.round(project.captions.position * 100)}%`}
                  onChange={(v) =>
                    onUpdateSequence((p) => {
                      if (p.captions) p.captions.position = v;
                    })
                  }
                />
                <label className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  <span>Highlight Active Word</span>
                  <input
                    type="checkbox"
                    checked={project.captions.highlight}
                    onChange={(e) =>
                      onUpdateSequence((p) => {
                        if (p.captions) p.captions.highlight = e.target.checked;
                      })
                    }
                  />
                </label>
              </>
            )}
          </Section>

          {project.audioTracks.length > 1 && (
            <Section title="AUDIO DUCKING">
              {project.audioTracks.slice(1).map((tr, idx) => (
                <div key={tr.id} className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span style={{ color: 'var(--text-dim)' }}>A{idx + 2} Duck Under</span>
                    <select
                      value={tr.duckUnder ?? ''}
                      onChange={(e) => {
                        const val = e.target.value || undefined;
                        onUpdateSequence((p) => {
                          const target = p.audioTracks.find((x) => x.id === tr.id);
                          if (target) {
                            target.duckUnder = val;
                            if (val && target.duckDB === undefined) target.duckDB = -10;
                          }
                        });
                      }}
                      className="px-2 py-0.5 rounded text-[11px] outline-none"
                      style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                    >
                      <option value="">Off</option>
                      {project.audioTracks
                        .filter((other) => other.id !== tr.id)
                        .map((other) => (
                          <option key={other.id} value={other.id}>
                            A{project.audioTracks.findIndex((x) => x.id === other.id) + 1}
                          </option>
                        ))}
                    </select>
                  </div>
                  {tr.duckUnder && (
                    <SliderRow
                      label="Duck dB"
                      value={tr.duckDB ?? -10}
                      min={-24}
                      max={-2}
                      step={1}
                      display={`${Math.round(tr.duckDB ?? -10)} dB`}
                      onChange={(v) =>
                        onUpdateSequence((p) => {
                          const target = p.audioTracks.find((x) => x.id === tr.id);
                          if (target) target.duckDB = v;
                        })
                      }
                    />
                  )}
                </div>
              ))}
            </Section>
          )}
        </>
      ) : (
        <>
          {selectedClip.kind !== 'audio' && (
            <>
              <Section
                title="TRANSFORM"
                right={
                  <button
                    onClick={() => onUpdateClip(selectedClip.id, (c) => (c.transform = undefined))}
                    style={{ color: 'var(--text-dim)' }}
                    title="Reset transform"
                  >
                    <RotateCcw size={11} />
                  </button>
                }
              >
                <SliderRow
                  label="Scale"
                  value={selectedClip.transform?.scale ?? 1}
                  min={0.25}
                  max={4}
                  step={0.05}
                  display={`${Math.round((selectedClip.transform?.scale ?? 1) * 100)}%`}
                  onChange={(val) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.transform = { ...(c.transform ?? { scale: 1, x: 0, y: 0 }), scale: val };
                    })
                  }
                />
                <SliderRow
                  label="Pos X"
                  value={selectedClip.transform?.x ?? 0}
                  min={-0.5}
                  max={0.5}
                  step={0.01}
                  display={(selectedClip.transform?.x ?? 0).toFixed(2)}
                  onChange={(val) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.transform = { ...(c.transform ?? { scale: 1, x: 0, y: 0 }), x: val };
                    })
                  }
                />
                <SliderRow
                  label="Pos Y"
                  value={selectedClip.transform?.y ?? 0}
                  min={-0.5}
                  max={0.5}
                  step={0.01}
                  display={(selectedClip.transform?.y ?? 0).toFixed(2)}
                  onChange={(val) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.transform = { ...(c.transform ?? { scale: 1, x: 0, y: 0 }), y: val };
                    })
                  }
                />
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    Zoom Move
                  </span>
                  <div className="flex gap-1">
                    {(['none', 'in', 'inOut', 'out'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() =>
                          onUpdateClip(selectedClip.id, (c) => {
                            if (m === 'none') {
                              if (c.transform) c.transform.zoom = undefined;
                            } else {
                              const cur = c.transform ?? { scale: 1.25, x: 0, y: 0 };
                              if (cur.scale <= 1.02) cur.scale = 1.25;
                              cur.zoom = starterZoomMove(m, c.duration);
                              c.transform = cur;
                            }
                          })
                        }
                        className="px-1.5 py-0.5 rounded text-[10px]"
                        style={{
                          background:
                            (selectedClip.transform?.zoom?.mode ?? 'none') === m
                              ? 'var(--accent)'
                              : 'var(--button)',
                          color:
                            (selectedClip.transform?.zoom?.mode ?? 'none') === m
                              ? '#FFF'
                              : 'var(--chip)',
                        }}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </Section>

              <Section
                title="COLOR"
                right={
                  <div className="flex items-center gap-1.5">
                    {selectedClip.grade && (
                      <button
                        onClick={() => onCopyGrade(selectedClip.grade!)}
                        style={{ color: 'var(--text-dim)' }}
                        title="Copy grade"
                      >
                        <Copy size={11} />
                      </button>
                    )}
                    {copiedGrade && (
                      <button
                        onClick={() =>
                          onUpdateClip(selectedClip.id, (c) => {
                            c.grade = JSON.parse(JSON.stringify(copiedGrade)) as ColorGrade;
                          })
                        }
                        style={{ color: 'var(--text-dim)' }}
                        title="Paste grade"
                      >
                        <ClipboardPaste size={11} />
                      </button>
                    )}
                    <button
                      onClick={() => onUpdateClip(selectedClip.id, (c) => (c.grade = undefined))}
                      style={{ color: 'var(--text-dim)' }}
                      title="Reset color"
                    >
                      <RotateCcw size={11} />
                    </button>
                  </div>
                }
              >
                <div className="flex items-center gap-2">
                  <select
                    value={selectedClip.grade?.look ?? ''}
                    onChange={(e) => {
                      const val = e.target.value || undefined;
                      onUpdateClip(selectedClip.id, (c) => {
                        c.grade = { ...(c.grade ?? {}), look: val };
                      });
                    }}
                    className="flex-1 px-2 py-1 rounded text-[11px] outline-none"
                    style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                  >
                    <option value="">No Look</option>
                    {BUILT_IN_LOOKS.map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={async () => {
                      const p = await window.vectrail.pickCubeFile();
                      if (p) {
                        onUpdateClip(selectedClip.id, (c) => {
                          c.grade = { ...(c.grade ?? {}), look: p };
                        });
                      }
                    }}
                    className="px-2 py-1 rounded text-[10px]"
                    style={{ background: 'var(--button)', color: 'var(--chip)' }}
                  >
                    .cube
                  </button>
                </div>
                {selectedClip.grade?.look && (
                  <SliderRow
                    label="Intensity"
                    value={selectedClip.grade?.lookIntensity ?? 1}
                    min={0}
                    max={1}
                    step={0.05}
                    display={`${Math.round((selectedClip.grade?.lookIntensity ?? 1) * 100)}%`}
                    onChange={(v) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        c.grade = { ...(c.grade ?? {}), lookIntensity: v };
                      })
                    }
                  />
                )}
                <SliderRow
                  label="Exposure"
                  value={selectedClip.grade?.exposure ?? 0}
                  min={-2}
                  max={2}
                  step={0.05}
                  display={(selectedClip.grade?.exposure ?? 0).toFixed(2)}
                  onChange={(v) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.grade = { ...(c.grade ?? {}), exposure: v };
                    })
                  }
                />
                <SliderRow
                  label="Contrast"
                  value={selectedClip.grade?.contrast ?? 0}
                  min={-50}
                  max={50}
                  step={1}
                  display={String(Math.round(selectedClip.grade?.contrast ?? 0))}
                  onChange={(v) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.grade = { ...(c.grade ?? {}), contrast: v };
                    })
                  }
                />
                <SliderRow
                  label="Saturation"
                  value={selectedClip.grade?.saturation ?? 0}
                  min={-100}
                  max={100}
                  step={1}
                  display={String(Math.round(selectedClip.grade?.saturation ?? 0))}
                  onChange={(v) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.grade = { ...(c.grade ?? {}), saturation: v };
                    })
                  }
                />
                <SliderRow
                  label="Temp"
                  value={selectedClip.grade?.temperature ?? 0}
                  min={-50}
                  max={50}
                  step={1}
                  display={String(Math.round(selectedClip.grade?.temperature ?? 0))}
                  onChange={(v) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.grade = { ...(c.grade ?? {}), temperature: v };
                    })
                  }
                />
                <SliderRow
                  label="Tint"
                  value={selectedClip.grade?.tint ?? 0}
                  min={-50}
                  max={50}
                  step={1}
                  display={String(Math.round(selectedClip.grade?.tint ?? 0))}
                  onChange={(v) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      c.grade = { ...(c.grade ?? {}), tint: v };
                    })
                  }
                />
                <div className="flex justify-between pt-2">
                  <ColorWheel
                    label="Shadows"
                    point={selectedClip.grade?.shadows ?? { x: 0, y: 0 }}
                    onChange={(pt) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        c.grade = { ...(c.grade ?? {}), shadows: pt };
                      })
                    }
                  />
                  <ColorWheel
                    label="Midtones"
                    point={selectedClip.grade?.midtones ?? { x: 0, y: 0 }}
                    onChange={(pt) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        c.grade = { ...(c.grade ?? {}), midtones: pt };
                      })
                    }
                  />
                  <ColorWheel
                    label="Highlights"
                    point={selectedClip.grade?.highlights ?? { x: 0, y: 0 }}
                    onChange={(pt) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        c.grade = { ...(c.grade ?? {}), highlights: pt };
                      })
                    }
                  />
                </div>
              </Section>
            </>
          )}

          {selectedClip.kind === 'solid' && (
            <Section title="SOLID">
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  Color
                </span>
                <input
                  type="color"
                  value={rgbaToHex(selectedClip.color ?? { r: 0.07, g: 0.07, b: 0.09, a: 1 })}
                  onChange={(e) => {
                    const col = hexToRgba(e.target.value);
                    if (col) {
                      onUpdateClip(selectedClip.id, (c) => {
                        c.color = col;
                      });
                    }
                  }}
                />
              </div>
            </Section>
          )}

          {selectedClip.kind === 'text' && selectedClip.text && (
            <Section title="TITLE">
              <input
                value={selectedClip.text.string}
                onChange={(e) =>
                  onUpdateClip(selectedClip.id, (c) => {
                    if (c.text) c.text.string = e.target.value;
                  })
                }
                className="w-full px-2 py-1 rounded text-[11px] outline-none"
                style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
              />
              <div className="flex items-center gap-1.5">
                <select
                  value={selectedClip.text.fontName ?? ''}
                  onChange={(e) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      if (c.text) c.text.fontName = e.target.value;
                    })
                  }
                  className="flex-1 px-2 py-1 rounded text-[11px] outline-none"
                  style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                >
                  {FONT_CHOICES.map((f) => (
                    <option key={f.label} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    onUpdateClip(selectedClip.id, (c) => {
                      if (c.text) c.text.bold = !c.text.bold;
                    })
                  }
                  className="px-2 py-1 rounded text-[11px] font-bold"
                  style={{
                    background: selectedClip.text.bold ? 'var(--accent)' : 'var(--button)',
                    color: selectedClip.text.bold ? '#FFF' : 'var(--text)',
                  }}
                  title="Bold"
                >
                  B
                </button>
              </div>
              <SliderRow
                label="Size"
                value={selectedClip.text.size}
                min={24}
                max={320}
                step={2}
                display={`${Math.round(selectedClip.text.size)}pt`}
                onChange={(v) =>
                  onUpdateClip(selectedClip.id, (c) => {
                    if (c.text) c.text.size = v;
                  })
                }
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  Color
                </span>
                <input
                  type="color"
                  value={rgbaToHex(selectedClip.text.color)}
                  onChange={(e) => {
                    const col = hexToRgba(e.target.value);
                    if (col) {
                      onUpdateClip(selectedClip.id, (c) => {
                        if (c.text) c.text.color = col;
                      });
                    }
                  }}
                />
              </div>
              <SliderRow
                label="Stroke"
                value={selectedClip.text.strokeWidth ?? 0}
                min={0}
                max={16}
                step={1}
                display={`${Math.round(selectedClip.text.strokeWidth ?? 0)}px`}
                onChange={(v) =>
                  onUpdateClip(selectedClip.id, (c) => {
                    if (c.text) {
                      c.text.strokeWidth = v;
                      if (v > 0 && !c.text.strokeColor) c.text.strokeColor = { r: 0, g: 0, b: 0, a: 1 };
                    }
                  })
                }
              />
              {(selectedClip.text.strokeWidth ?? 0) > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    Stroke Color
                  </span>
                  <input
                    type="color"
                    value={rgbaToHex(selectedClip.text.strokeColor ?? { r: 0, g: 0, b: 0, a: 1 })}
                    onChange={(e) => {
                      const col = hexToRgba(e.target.value);
                      if (col) {
                        onUpdateClip(selectedClip.id, (c) => {
                          if (c.text) c.text.strokeColor = col;
                        });
                      }
                    }}
                  />
                </div>
              )}
              <div className="flex items-center justify-between pt-0.5">
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  Background Pill
                </span>
                <div className="flex items-center gap-2">
                  {selectedClip.text.bgColor && (selectedClip.text.bgColor.a ?? 1) > 0 && (
                    <input
                      type="color"
                      value={rgbaToHex(selectedClip.text.bgColor)}
                      onChange={(e) => {
                        const col = hexToRgba(e.target.value);
                        if (col) {
                          onUpdateClip(selectedClip.id, (c) => {
                            if (c.text) c.text.bgColor = { ...col, a: c.text.bgColor?.a ?? 0.75 };
                          });
                        }
                      }}
                    />
                  )}
                  <button
                    onClick={() =>
                      onUpdateClip(selectedClip.id, (c) => {
                        if (!c.text) return;
                        if (c.text.bgColor && (c.text.bgColor.a ?? 1) > 0) {
                          delete c.text.bgColor;
                        } else {
                          c.text.bgColor = { r: 0.06, g: 0.06, b: 0.08, a: 0.75 };
                          c.text.bgPadding = c.text.bgPadding ?? 16;
                        }
                      })
                    }
                    className="px-2 py-0.5 rounded text-[10px] font-medium"
                    style={{
                      background:
                        selectedClip.text.bgColor && (selectedClip.text.bgColor.a ?? 1) > 0
                          ? 'var(--accent)'
                          : 'var(--button)',
                      color:
                        selectedClip.text.bgColor && (selectedClip.text.bgColor.a ?? 1) > 0
                          ? '#FFF'
                          : 'var(--text)',
                    }}
                  >
                    {selectedClip.text.bgColor && (selectedClip.text.bgColor.a ?? 1) > 0 ? 'On' : 'Off'}
                  </button>
                </div>
              </div>
              {selectedClip.text.bgColor && (selectedClip.text.bgColor.a ?? 1) > 0 && (
                <>
                  <SliderRow
                    label="Bg Opacity"
                    value={selectedClip.text.bgColor.a ?? 0.75}
                    min={0.1}
                    max={1}
                    step={0.05}
                    display={`${Math.round((selectedClip.text.bgColor.a ?? 0.75) * 100)}%`}
                    onChange={(v) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        if (c.text?.bgColor) c.text.bgColor = { ...c.text.bgColor, a: v };
                      })
                    }
                  />
                  <SliderRow
                    label="Bg Padding"
                    value={selectedClip.text.bgPadding ?? 16}
                    min={4}
                    max={40}
                    step={2}
                    display={`${Math.round(selectedClip.text.bgPadding ?? 16)}px`}
                    onChange={(v) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        if (c.text) c.text.bgPadding = v;
                      })
                    }
                  />
                </>
              )}
            </Section>
          )}

          <Section title="PLAYBACK & FADES">
            {(selectedClip.kind === 'video' || selectedClip.kind === 'audio') && (
              <>
                <SliderRow
                  label="Speed"
                  value={selectedClip.speed ?? 1}
                  min={0.25}
                  max={4}
                  step={0.05}
                  display={`${(selectedClip.speed ?? 1).toFixed(2)}x`}
                  onChange={(v) =>
                    onUpdateClip(selectedClip.id, (c) => {
                      retimeClip(c, (t) => snapFrame(t, project.fps), 1 / project.fps, (cl) => {
                        cl.ramp = undefined;
                        cl.speed = v;
                      });
                    })
                  }
                />
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    Speed Ramp
                  </span>
                  <button
                    onClick={() =>
                      onUpdateClip(selectedClip.id, (c) => {
                        if (c.ramp) {
                          retimeClip(c, (t) => snapFrame(t, project.fps), 1 / project.fps, (cl) => {
                            cl.ramp = undefined;
                          });
                        } else {
                          const span = c.duration * (c.speed ?? 1);
                          const ease = Math.min(0.4, span * 0.2);
                          retimeClip(c, (t) => snapFrame(t, project.fps), 1 / project.fps, (cl) => {
                            cl.speed = 0.5;
                            cl.ramp = {
                              inFrom: Math.max(0, span * 0.15),
                              inTo: Math.max(0.05, span * 0.15 + ease),
                              outFrom: Math.max(span * 0.15 + ease + 0.05, span * 0.85 - ease),
                              outTo: Math.min(span, span * 0.85),
                              startSpeed: 1,
                              endSpeed: 1,
                            };
                          });
                        }
                      })
                    }
                    className="px-2 py-0.5 rounded text-[10px]"
                    style={{
                      background: selectedClip.ramp ? 'var(--accent)' : 'var(--button)',
                      color: selectedClip.ramp ? '#FFF' : 'var(--chip)',
                    }}
                  >
                    {selectedClip.ramp ? 'Clear Ramp' : 'Ease Ramp'}
                  </button>
                </div>
                {selectedClip.ramp && (
                  <SliderRow
                    label="Mid Speed"
                    value={selectedClip.speed ?? 0.5}
                    min={0.15}
                    max={3}
                    step={0.05}
                    display={`${(selectedClip.speed ?? 0.5).toFixed(2)}x`}
                    onChange={(v) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        retimeClip(c, (t) => snapFrame(t, project.fps), 1 / project.fps, (cl) => {
                          cl.speed = v;
                        });
                      })
                    }
                  />
                )}
                <div className="flex gap-1.5 pt-1">
                  {selectedClip.kind === 'video' && (
                    <button
                      onClick={() => onFreezeFrame(selectedClip.id)}
                      className="flex-1 py-1 rounded text-[10px]"
                      style={{ background: 'var(--button)', color: 'var(--chip)' }}
                    >
                      Freeze Frame
                    </button>
                  )}
                  <button
                    onClick={() => onReverseClip(selectedClip.id)}
                    className="flex-1 py-1 rounded text-[10px]"
                    style={{
                      background: selectedClip.reversed ? 'var(--accent)' : 'var(--button)',
                      color: selectedClip.reversed ? '#FFF' : 'var(--chip)',
                    }}
                  >
                    Reverse
                  </button>
                  {selectedClip.linkID && (
                    <button
                      onClick={() => onDetachAudio(selectedClip.id)}
                      className="flex-1 py-1 rounded text-[10px]"
                      style={{ background: 'var(--button)', color: 'var(--chip)' }}
                    >
                      Detach
                    </button>
                  )}
                </div>
              </>
            )}
            {selectedClip.kind === 'audio' && (
              <SliderRow
                label="Gain"
                value={selectedClip.gainDB ?? 0}
                min={-60}
                max={12}
                step={0.5}
                display={formatDB(selectedClip.gainDB ?? 0)}
                onChange={(v) =>
                  onUpdateClip(selectedClip.id, (c) => {
                    c.gainDB = v;
                  })
                }
              />
            )}
            <SliderRow
              label="Fade In"
              value={selectedClip.fadeIn ?? 0}
              min={0}
              max={Math.min(5, selectedClip.duration)}
              step={0.05}
              display={`${(selectedClip.fadeIn ?? 0).toFixed(2)}s`}
              onChange={(v) =>
                onUpdateClip(selectedClip.id, (c) => {
                  c.fadeIn = v;
                })
              }
            />
            <SliderRow
              label="Fade Out"
              value={selectedClip.fadeOut ?? 0}
              min={0}
              max={Math.min(5, selectedClip.duration)}
              step={0.05}
              display={`${(selectedClip.fadeOut ?? 0).toFixed(2)}s`}
              onChange={(v) =>
                onUpdateClip(selectedClip.id, (c) => {
                  c.fadeOut = v;
                })
              }
            />
            {((selectedClip.fadeIn ?? 0) > 0 || (selectedClip.fadeOut ?? 0) > 0) && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  Fade Curve
                </span>
                <select
                  value={selectedClip.fadeInCurve ?? 'smooth'}
                  onChange={(e) => {
                    const val = e.target.value as FadeCurve;
                    onUpdateClip(selectedClip.id, (c) => {
                      c.fadeInCurve = val;
                      c.fadeOutCurve = val;
                    });
                  }}
                  className="px-2 py-1 rounded text-[11px] outline-none"
                  style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                >
                  <option value="smooth">Smooth</option>
                  <option value="linear">Linear</option>
                  <option value="easeIn">Ease In</option>
                  <option value="easeOut">Ease Out</option>
                </select>
              </div>
            )}
            {selectedClip.kind !== 'audio' && (
              <>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    Transition In
                  </span>
                  <select
                    value={selectedClip.transitionIn?.kind ?? 'none'}
                    onChange={(e) => {
                      const val = e.target.value;
                      onUpdateClip(selectedClip.id, (c) => {
                        c.transitionIn =
                          val === 'none'
                            ? undefined
                            : { kind: val as TransitionKind, duration: c.transitionIn?.duration ?? 0.5 };
                      });
                    }}
                    className="px-2 py-1 rounded text-[11px] outline-none"
                    style={{ background: 'var(--field)', color: 'var(--text)', border: '1px solid var(--stroke)' }}
                  >
                    <option value="none">None</option>
                    <option value="dissolve">Dissolve</option>
                    <option value="dipToBlack">Dip to Black</option>
                    <option value="wipe">Wipe</option>
                  </select>
                </div>
                {selectedClip.transitionIn && (
                  <SliderRow
                    label="Trans Dur"
                    value={selectedClip.transitionIn.duration}
                    min={0.1}
                    max={Math.min(3, selectedClip.duration)}
                    step={0.05}
                    display={`${selectedClip.transitionIn.duration.toFixed(2)}s`}
                    onChange={(v) =>
                      onUpdateClip(selectedClip.id, (c) => {
                        if (c.transitionIn) c.transitionIn.duration = v;
                      })
                    }
                  />
                )}
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
};
