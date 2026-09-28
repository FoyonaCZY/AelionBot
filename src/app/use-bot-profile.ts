import { useState } from 'react';
import type { Bot, ModelSelection } from '../../shared/types/core';
import type { BotType } from '../../shared/types/designer-types';
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
  const [type, setType] = useState<BotType>('general'),
    [originalType, setOriginalType] = useState<BotType>('general');
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
    setType('general');
    setName('');
    setSoul(defaultSoul('general', language));
    setModel(null);
    setImageModel(null);
    setReasoning(defaultReasoning);
  };
  const startEdit = (target: Bot) => {
    setType(target.type || 'general');
    setOriginalType(target.type || 'general');
    setEditingId(target.id);
    setName(target.name);
    setSoul(target.soul);
    setModel(target.model ? { ...target.model } : null);
    setImageModel(target.imageModel ? { ...target.imageModel } : null);
    setReasoning(target.reasoningEffort || '');
    setPalette(displayBotPalette(target));
  };
  const save = async (input: {
    creating: boolean;
    confirmContextReset: boolean;
    onCreated: (id: string) => void;
    onContextReset: (id: string) => void;
  }) => {
    if (input.creating) {
      const created = await window.aelion.createBot({
        type,
        name: name || t('新 Bot'),
        soul,
        model,
        imageModel,
        reasoningEffort: reasoning || null,
        ...newBotPalette,
      });
      input.onCreated(created.id);
    } else {
      await window.aelion.updateBot({
        id: editingId,
        name,
        soul,
        type,
        expectedType: originalType,
        confirmContextReset: input.confirmContextReset,
        model,
        imageModel,
        reasoningEffort: reasoning || null,
        color: palette.color,
        avatarStyle: palette.avatarStyle ?? null,
      });
      if (input.confirmContextReset) input.onContextReset(editingId);
    }
  };
  return {
    type,
    setType,
    originalType,
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
