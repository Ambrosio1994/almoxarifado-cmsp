BEGIN;

UPDATE notification_rules
SET dias_aviso_interno = ARRAY[7, 14, 21, 31],
    dia_oficio_fornecedor = 30,
    atualizado_em = now()
WHERE dias_aviso_interno = ARRAY[14, 21, 28]
  AND dia_oficio_fornecedor = 31;

UPDATE app_settings
SET value = jsonb_set(
      jsonb_set(value, '{notificationRules,diasAvisoInterno}', '[7,14,21,31]'::jsonb, true),
      '{notificationRules,diaOficioFornecedor}', '30'::jsonb, true
    ),
    updated_at = now()
WHERE key = 'configuracoes'
  AND COALESCE(value #> '{notificationRules,diasAvisoInterno}', '[]'::jsonb) = '[14,21,28]'::jsonb
  AND COALESCE(value #>> '{notificationRules,diaOficioFornecedor}', '31') = '31';

COMMIT;
