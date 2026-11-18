/**
 * First use of a type (T200, D292 (1)): the question, per cable row of a draft type, Required or
 * Optional. `TypeSetupHost` is mounted once in the root layout and opens the sheet when a screen
 * hands it questions (`askTypeSetup`: Add device, placing a draft, accepting device drafts, an
 * accessory added on the card); Setup's "Types to set up" step lists the same cards inline
 * (`TypeSetupCard`), each with its own Confirm. Later is always there and writes nothing: the
 * surveyor is never blocked, offline included. Test IDs `typeSetup.*`.
 */

import { Editor, LIBRARY_STREAM, OpError } from '@field-survey/core';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { useCurrentUser } from '../identity/IdentityGate';
import { logTo } from '../log';
import { Btn, Chip, FormActions, color, font, radius, shadow, space } from '../ui';
import { answerLine, answerTypeSetup, mergeQuestions, onTypeSetup, type TypeSetupAnswer, type TypeSetupQuestion } from './typeSetup';

/** iOS presents a Modal in portrait unless told otherwise, and the app is landscape-only. */
const ORIENTATIONS = ['landscape-left', 'landscape-right'] as const;

/** What the sheet and the Setup step say above the cards. */
export const TYPE_SETUP_INTRO =
  'First use of this type. Which of its cables must every device of it have? Required runs become drafts on each device; Optional ones are only offered. Saved to the library for every project, and edited there later.';

/** One type's rows, each Required or Optional. */
export function TypeSetupCard({ q, answer, onAnswer, footer }: { q: TypeSetupQuestion; answer: TypeSetupAnswer; onAnswer: (key: string, required: boolean) => void; footer?: ReactNode }) {
  return (
    <View style={styles.card} testID={`typeSetup.type.${q.model}`}>
      <View style={styles.cardHead}>
        <Text style={styles.model}>{q.model}</Text>
        <Text style={styles.meta}>{[q.via ? `accessory of ${q.via}` : q.category, answerLine(q, answer)].filter(Boolean).join(' · ')}</Text>
      </View>
      {q.rows.map((r) => {
        const required = answer[r.key] ?? r.required;
        return (
          <View key={r.key} style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.line}>{r.line}</Text>
              {r.why ? <Text style={styles.why}>Suggested: {r.why}</Text> : null}
            </View>
            <Chip small label="Required" selected={required} onPress={() => onAnswer(r.key, true)} testID={`typeSetup.${q.model}.${r.key}.required`} />
            <Chip small label="Optional" selected={!required} onPress={() => onAnswer(r.key, false)} testID={`typeSetup.${q.model}.${r.key}.optional`} />
          </View>
        );
      })}
      {footer}
    </View>
  );
}

/** Answers by type id, row key. */
type Answers = Record<string, Record<string, boolean>>;
const withAnswer = (all: Answers, typeId: string, key: string, required: boolean): Answers => ({ ...all, [typeId]: { ...(all[typeId] ?? {}), [key]: required } });

/** Confirm every listed type: one group each, on the library stream. Returns how many were written. */
async function confirmAll(userId: string, questions: readonly TypeSetupQuestion[], answers: Answers): Promise<number> {
  const store = await openAppStore();
  const editor = new Editor(store, { projectId: LIBRARY_STREAM, userId });
  let n = 0;
  for (const q of questions) if (await answerTypeSetup(editor, store, q, answers[q.typeId] ?? {})) n++;
  return n;
}

/** The sheet, mounted once (root layout): opens when a screen asks, closes on Confirm or Later. */
export function TypeSetupHost() {
  const user = useCurrentUser();
  const [questions, setQuestions] = useState<TypeSetupQuestion[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onTypeSetup((more) => setQuestions((open) => mergeQuestions(open, more))), []);

  const close = () => {
    setQuestions([]);
    setAnswers({});
    setError(null);
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await confirmAll(user.id, questions, answers);
      logTo('store', 'info', 'type_setup', { types: questions.map((q) => q.model), written: n });
      close();
    } catch (e) {
      setError(e instanceof OpError ? e.message : `Not saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!questions.length) return null;
  const one = questions.length === 1 ? questions[0]! : null;
  return (
    <Modal visible transparent animationType="fade" supportedOrientations={[...ORIENTATIONS]} onRequestClose={close}>
      <View style={styles.scrim}>
        <View style={styles.box} testID="typeSetup.sheet">
          <Text style={styles.title}>{one ? `Set up ${one.model}` : `Types to set up (${questions.length})`}</Text>
          <Text style={styles.body}>{TYPE_SETUP_INTRO}</Text>
          <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
            {questions.map((q) => (
              <TypeSetupCard key={q.typeId} q={q} answer={answers[q.typeId] ?? {}} onAnswer={(key, req) => setAnswers((a) => withAnswer(a, q.typeId, key, req))} />
            ))}
          </ScrollView>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <FormActions>
            <Btn title="Later" onPress={close} disabled={busy} testID="typeSetup.later" />
            <Btn title="Confirm" kind="primary" onPress={() => void confirm()} loading={busy} testID="typeSetup.confirm" />
          </FormActions>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Setup's "Types to set up" (T200): every type the project uses that still waits for its first-use
 * answer — what a seed import or a review brought in — each with its own Confirm.
 */
export function TypeSetupList({ questions, onDone }: { questions: readonly TypeSetupQuestion[]; onDone: (notice: string) => void }) {
  const user = useCurrentUser();
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = async (q: TypeSetupQuestion) => {
    setBusy(q.typeId);
    setError(null);
    try {
      const n = await confirmAll(user.id, [q], answers);
      onDone(n ? `${q.model} set up: ${answerLine(q, answers[q.typeId] ?? {})}` : `${q.model} was set up already`);
    } catch (e) {
      setError(e instanceof OpError ? e.message : `Not saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={styles.listBody}>
      <Text style={styles.body}>{questions.length ? TYPE_SETUP_INTRO : 'Every type this project uses is set up.'}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {questions.map((q) => (
        <TypeSetupCard
          key={q.typeId}
          q={q}
          answer={answers[q.typeId] ?? {}}
          onAnswer={(key, req) => setAnswers((a) => withAnswer(a, q.typeId, key, req))}
          footer={
            <FormActions>
              <Btn title="Confirm" kind="primary" small onPress={() => void confirm(q)} loading={busy === q.typeId} disabled={busy !== null} testID={`typeSetup.confirm.${q.model}`} />
            </FormActions>
          }
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: `${color.text}40`, alignItems: 'center', justifyContent: 'center' },
  box: { width: 640, maxHeight: '86%', backgroundColor: color.surface, borderRadius: radius.card, padding: space.xl, gap: space.md, ...shadow.card },
  title: { ...font.title, color: color.text },
  body: { ...font.callout, color: color.text2 },
  error: { ...font.callout, color: color.danger },
  list: { flexGrow: 0 },
  listBody: { gap: space.md },
  card: { borderWidth: 1, borderColor: color.hairline, borderRadius: radius.card, padding: space.md, gap: space.sm },
  cardHead: { gap: 2 },
  model: { ...font.headline, color: color.text },
  meta: { ...font.caption, color: color.text3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowText: { flex: 1, gap: 2 },
  line: { ...font.callout, color: color.text },
  why: { ...font.caption, color: color.text3 },
});
