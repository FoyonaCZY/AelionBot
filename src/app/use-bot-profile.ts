import { useState } from 'react';
import type { Bot, ModelSelection } from '../../shared/types/core';
import {
  randomBotPalette,
  displayBotPalette,
  DEFAULT_BOT_PALETTE,
  type BotPalette,
} from '../../shared/chat/bot-colors';
import { useI18n } from '../i18n';
import { defaultSoul } from '../../shared/chat/soul-presets';

/** The create/edit Bot form. `newBotPalette` also colours the avatar preview in the sidebar's New menu. */
export function useBotProfile() {
  const { t, language } = useI18n();
  const [newBotPalette, setNewBotPalette] = useState(randomBotPalette);
  const [palette, setPalette] = useState<BotPalette>({ ...DEFAULT_BOT_PALETTE });
  const [editingId, setEditingId] = useState(''),
    [name, setName] = useState(''),
    [soul, setSoul] = useState('');
  const [model, setModel] = useState<ModelSelection | null>(null),
    [imageModel, setImageModel] = useState<ModelSelection | null>(null);
  const [reasoning, setReasoning] = useState('');
  const shuffleNewPalette = () => setNewBotPalette(randomBotPalette(newBotPalette));
  const startNew = (defaultReasoning: string) => {
    setName('');
    setSoul(defaultSoul('general', language));
    setModel(null);
    setImageModel(null);
    setReasoning(defaultReasoning);
  };
  const startEdit = (target: Bot) => {
    setEditingId(target.id);
    setName(target.name);
    setSoul(target.soul);
    setModel(target.model ? { ...target.model } : null);
    setImageModel(target.imageModel ? { ...target.imageModel } : null);
    setReasoning(target.reasoningEffort || '');
    setPalette(displayBotPalette(target));
  };
  const save = async (input: { creating: boolean; onCreated: (id: string) => void }) => {
    if (input.creating) {
      const created = await window.aelion.createBot({
        name: name || t('新 Bot'),
        soul,
        model,
        imageModel,
        reasoningEffort: reasoning || null,
        ...newBotPalette,
      });
      input.onCreated(created.id);
    } else
      await window.aelion.updateBot({
        id: editingId,
        name,
        soul,
        model,
        imageModel,
        reasoningEffort: reasoning || null,
        color: palette.color,
        avatarStyle: palette.avatarStyle ?? null,
      });
  };
  return {
    editingId,
    name,
    setName,
    soul,
    setSoul,
    model,
    setModel,
    imageModel,
    setImageModel,
    reasoning,
    setReasoning,
    newBotPalette,
    setNewBotPalette,
    palette,
    setPalette,
    shuffleNewPalette,
    startNew,
    startEdit,
    save,
  };
}

export type BotProfile = ReturnType<typeof useBotProfile>;
