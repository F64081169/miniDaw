// Genre coach panel: pick a genre, read its traits, and follow the arrangement steps one by one
// (each step explains the idea and can generate that part of the arrangement).

import { useMemo, useState } from 'react';
import { engine } from '../audio/engine';
import { CATEGORY_INFO, getPatch } from '../audio/instruments/patches';
import type { CoachState } from '../core/types';
import { applyAll, applyStep, buildSteps, clearGenre, progressionPreview, progressionSymbols, selectGenre, setCoachOption, toggleStepDone } from '../music/coach';
import { SECTION_LABEL } from '../music/generate/common';
import { GENRES, getGenre } from '../music/genres';
import type { GenreDef, StepId } from '../music/genres/types';
import { keyName, MODE_LABELS } from '../music/theory';
import { addAudioTrack, setBpm, toggleArm } from '../state/actions';
import { useDaw } from '../state/store';
import { Icon } from './icons';

const st = () => useDaw.getState();

function GenrePicker() {
  return (
    <div className="coach-pick">
      <p className="coach-lead">選一個你想做的曲風。教練會告訴你這種音樂「為什麼聽起來是這樣」，並一步一步帶你把鼓、貝斯、和弦、旋律和混音做出來——每一步都可以一鍵生成，再照自己的想法修改。</p>
      <div className="genre-grid">
        {GENRES.map((g) => (
          <button key={g.id} type="button" className="genre-card" style={{ ['--gc' as string]: g.color }} onClick={() => selectGenre(g.id)}>
            <span className="genre-name">{g.name}</span>
            <span className="genre-en">{g.nameEn}</span>
            <span className="genre-tag">{g.tagline}</span>
            <span className="genre-bpm num">
              {g.bpm.min}–{g.bpm.max} BPM
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SectionsStrip({ g, s }: { g: GenreDef; s: CoachState }) {
  const structure = g.structures[s.structureIndex] ?? g.structures[0];
  const total = structure.sections.reduce((a, x) => a + x.bars, 0);
  return (
    <div className="sections-strip" aria-label="曲式">
      {structure.sections.map((x, i) => (
        <div key={i} className={`sec sec-${x.type}`} style={{ flexGrow: x.bars }} title={`${SECTION_LABEL[x.type]} ${x.bars} 小節`}>
          <span>{SECTION_LABEL[x.type]}</span>
        </div>
      ))}
      <span className="sections-total num">{total} 小節</span>
    </div>
  );
}

function Options({ g, s }: { g: GenreDef; s: CoachState }) {
  const bpm = useDaw((st2) => st2.project.bpm);
  const prog = g.progressions[s.progressionIndex] ?? g.progressions[0];
  const keys = useMemo(() => {
    const list = [...g.keys];
    for (let r = 0; r < 12; r++) {
      for (const mode of [g.keys[0].mode]) if (!list.some((k) => k.root === r && k.mode === mode)) list.push({ root: r, mode });
    }
    return list;
  }, [g]);
  return (
    <div className="coach-options">
      <label className="opt">
        <span>調性</span>
        <select
          value={`${s.keyRoot}:${s.keyMode}`}
          onChange={(e) => {
            const [r, m] = e.target.value.split(':');
            setCoachOption({ keyRoot: Number(r), keyMode: m as CoachState['keyMode'] });
          }}
        >
          {keys.map((k, i) => (
            <option key={`${k.root}:${k.mode}`} value={`${k.root}:${k.mode}`}>
              {keyName(k.root, k.mode)}
              {i < g.keys.length ? '（推薦）' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="opt">
        <span>速度</span>
        <input type="range" min={g.bpm.min} max={g.bpm.max} value={Math.min(g.bpm.max, Math.max(g.bpm.min, bpm))} onChange={(e) => setBpm(Number(e.target.value))} aria-label="速度" />
        <span className={`num ${bpm < g.bpm.min || bpm > g.bpm.max ? 'warn' : ''}`}>{bpm}</span>
      </label>
      <label className="opt opt-wide">
        <span>和弦進行</span>
        <select value={s.progressionIndex} onChange={(e) => setCoachOption({ progressionIndex: Number(e.target.value) })}>
          {g.progressions.map((p, i) => (
            <option key={i} value={i}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn icon-btn"
          title="試聽和弦進行"
          onClick={() => void engine.auditionPatch(g.roles.find((r) => r.step === 'harmony' && r.kind === 'comp')?.patch ?? 'piano.grand', progressionPreview(prog.prog, s), st().project.bpm)}
        >
          <Icon name="play" size={14} filled />
        </button>
      </label>
      <p className="prog-chords num">{progressionSymbols(prog.prog, s)}</p>
      {prog.chorus && <p className="prog-chords num">副歌：{progressionSymbols(prog.chorus, s)}</p>}
      <p className="prog-note">{prog.note}</p>
      <label className="opt opt-wide">
        <span>曲式</span>
        <select value={s.structureIndex} onChange={(e) => setCoachOption({ structureIndex: Number(e.target.value) })}>
          {g.structures.map((x, i) => (
            <option key={i} value={i}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <SectionsStrip g={g} s={s} />
    </div>
  );
}

function StepCard({ step, index, done, open, onToggle, g }: { step: ReturnType<typeof buildSteps>[number]; index: number; done: boolean; open: boolean; onToggle: () => void; g: GenreDef }) {
  const extra = (id: StepId) => {
    if (id === 'record')
      return (
        <button
          type="button"
          className="btn"
          onClick={() => {
            const tid = addAudioTrack('人聲');
            toggleArm(tid);
            st().setUi({ selectedTrackId: tid });
            st().toast('已新增音訊軌並待命錄音，按 R 開始錄音（建議戴耳機）');
          }}
        >
          <Icon name="mic" size={16} /> 新增人聲軌並待命
        </button>
      );
    if (id === 'export')
      return (
        <button type="button" className="btn" onClick={() => st().setUi({ dialog: { type: 'export' } })}>
          <Icon name="download" size={16} /> 開啟匯出
        </button>
      );
    return null;
  };
  return (
    <li className={`step-card ${done ? 'done' : ''} ${open ? 'open' : ''}`}>
      <button type="button" className="step-head" onClick={onToggle} aria-expanded={open}>
        <span className="step-num num" aria-hidden="true">
          {done ? <Icon name="check" size={14} /> : index + 1}
        </span>
        <span className="step-title">{step.title}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>
      {open && (
        <div className="step-body">
          {step.body.split('\n\n').map((para, i) => (
            <p key={i}>{para}</p>
          ))}
          {step.roles.length > 0 && (
            <ul className="role-list">
              {step.roles.map((r) => {
                const patch = getPatch(r.patch);
                return (
                  <li key={r.id} style={{ ['--cc' as string]: CATEGORY_INFO[patch.category].color }}>
                    <span className="role-icon" aria-hidden="true">
                      <Icon name={CATEGORY_INFO[patch.category].icon} size={16} />
                    </span>
                    <span>
                      <strong>{r.name}</strong>
                      <span className="role-patch">{patch.name}</span>
                      <span className="role-why">{r.why}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="step-actions">
            {step.auto && step.actionLabel && (
              <button type="button" className="btn btn-primary" onClick={() => applyStep(step.id)}>
                <Icon name="wand" size={16} /> {step.actionLabel}
              </button>
            )}
            {extra(step.id)}
            <button type="button" className="btn btn-ghost" onClick={() => toggleStepDone(step.id)} aria-pressed={done}>
              {done ? '標記為未完成' : '我做好了'}
            </button>
          </div>
          {step.auto && step.id !== 'setup' && step.id !== 'structure' && step.id !== 'mix' && <p className="step-hint">生成後可以在鋼琴捲簾裡修改音符，或再按一次重新生成（{g.name}的段落會依能量自動變化）。</p>}
        </div>
      )}
    </li>
  );
}

function GenreView({ g, s }: { g: GenreDef; s: CoachState }) {
  const [tab, setTab] = useState<'steps' | 'traits' | 'tips'>('steps');
  const project = useDaw((st2) => st2.project);
  const steps = useMemo(() => buildSteps(g, s), [g, s]);
  const doneFlags = steps.map((step) => step.done(project) || s.completed.includes(step.id));
  const firstOpen = doneFlags.findIndex((d) => !d);
  const [openId, setOpenId] = useState<StepId | null>(null);
  const current = openId ?? steps[firstOpen >= 0 ? firstOpen : 0]?.id;
  const doneCount = doneFlags.filter(Boolean).length;
  return (
    <div className="coach-genre" style={{ ['--gc' as string]: g.color }}>
      <div className="genre-hero">
        <button type="button" className="btn btn-ghost back" onClick={clearGenre}>
          <Icon name="chevronLeft" size={16} /> 換曲風
        </button>
        <h2 className="genre-title">{g.name}</h2>
        <div className="genre-sub">
          {g.nameEn} · {g.bpm.min}–{g.bpm.max} BPM · {g.timeSig[0]}/{g.timeSig[1]}
          {g.swing > 0.05 ? ` · Swing ${Math.round(g.swing * 100)}%` : ''}
        </div>
        <p className="genre-tagline">{g.tagline}</p>
      </div>
      <Options g={g} s={s} />
      <div className="coach-all">
        <button type="button" className="btn btn-primary btn-big" onClick={applyAll}>
          <Icon name="sparkle" size={18} /> 一鍵生成完整編曲
        </button>
        <span className="muted small">依目前的調性、進行與曲式建立所有音軌；會取代教練先前生成的音軌，你自己的音軌與錄音會保留。不滿意可以復原（⌘Z）。</span>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ['steps', `跟著做 ${doneCount}/${steps.length}`],
            ['traits', '曲風特色'],
            ['tips', '編曲小技巧'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'steps' && (
        <>
          <div className="progress" aria-hidden="true">
            <div style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <ol className="steps-list">
            {steps.map((step, i) => (
              <StepCard key={step.id} g={g} step={step} index={i} done={doneFlags[i]} open={current === step.id} onToggle={() => setOpenId(current === step.id ? ('__none' as StepId) : step.id)} />
            ))}
          </ol>
        </>
      )}
      {tab === 'traits' && (
        <div className="traits">
          <p className="overview">{g.overview}</p>
          <dl>
            {g.traits.map((t) => (
              <div key={t.title} className="trait">
                <dt>{t.title}</dt>
                <dd>{t.text}</dd>
              </div>
            ))}
          </dl>
          <h3>配器</h3>
          <ul className="role-list">
            {g.roles.map((r) => {
              const patch = getPatch(r.patch);
              return (
                <li key={r.id} style={{ ['--cc' as string]: CATEGORY_INFO[patch.category].color }}>
                  <span className="role-icon" aria-hidden="true">
                    <Icon name={CATEGORY_INFO[patch.category].icon} size={16} />
                  </span>
                  <span>
                    <strong>{r.name}</strong>
                    <span className="role-patch">{patch.name}</span>
                    <span className="role-why">{r.why}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <h3>常見和弦進行</h3>
          <ul className="prog-list">
            {g.progressions.map((p, i) => (
              <li key={i}>
                <div className="prog-head">
                  <strong>{p.name}</strong>
                  <button type="button" className="btn btn-ghost small" onClick={() => setCoachOption({ progressionIndex: i })}>
                    {s.progressionIndex === i ? '使用中' : '使用'}
                  </button>
                </div>
                <div className="prog-chords num">{progressionSymbols(p.prog, s)}</div>
                <div className="prog-note">{p.note}</div>
              </li>
            ))}
          </ul>
          <p className="muted small">代表風格：{g.references}</p>
        </div>
      )}
      {tab === 'tips' && (
        <div className="tips">
          <ul>
            {g.tips.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
          <h3>調式小抄</h3>
          <p className="muted">
            目前調性：{keyName(s.keyRoot, s.keyMode)}（{MODE_LABELS[s.keyMode]}）。鋼琴捲簾的「調性輔助」會標出這個調的音，照著寫旋律就不容易出錯。
          </p>
        </div>
      )}
    </div>
  );
}

export function CoachPanel() {
  const coach = useDaw((s) => s.project.coach);
  const g = getGenre(coach?.genreId);
  return (
    <aside className="coach" aria-label="曲風編曲教練">
      <div className="panel-head">
        <h2>
          <Icon name="coach" size={18} /> 曲風編曲教練
        </h2>
        <button type="button" className="btn icon-btn" title="關閉 (G)" onClick={() => st().setUi({ coachOpen: false })}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="coach-scroll">{g && coach ? <GenreView g={g} s={coach} /> : <GenrePicker />}</div>
    </aside>
  );
}

