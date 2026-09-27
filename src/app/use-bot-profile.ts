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

/** The create/edit Bot form. `newBotPalette` also colours the avatar preview in the sidebar's New menu. */
export function useBotProfile() {
  const { t, language } = useI18n();
  const [type, setType] = useState<BotType>('general'),
    [originalType, setOriginalType] = useState<BotType>('general');
  const [newBotPalette, setNewBotPalette] = useState(randomBotPalette);
  const [palette, setPalette] = useState<BotPalette>({ ...DEFAULT_BOT_PALETTE });
  const [editingId, setEditingId] = useState(''),
    [name, setName] = useState(''),
    [role, setRole] = useState('');
  const [model, setModel] = useState<ModelSelection | null>(null),
    [imageModel, setImageModel] = useState<ModelSelection | null>(null);
  const [reasoning, setReasoning] = useState('');
  const shuffleNewPalette = () => setNewBotPalette(randomBotPalette(newBotPalette));
  const startNew = (defaultReasoning: string) => {
    setType('general');
    setName('');
    setRole('');
    setModel(null);
    setImageModel(null);
    setReasoning(defaultReasoning);
  };
  const startEdit = (target: Bot) => {
    setType(target.type || 'general');
    setOriginalType(target.type || 'general');
    setEditingId(target.id);
    setName(target.name);
    setRole(target.role);
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
        role:
          role ||
          (type === 'designer'
            ? language === 'en'
              ? 'Create prototypes and editable presentations, follow the selected design system and verify deliverables.'
              : '完成原型和可编辑演示文稿设计，遵循所选设计系统并验证成果。'
            : t('完成办公和代码任务，使用工作电脑实际执行并核对成果。')),
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
        role,
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
    role,
    setRole,
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
