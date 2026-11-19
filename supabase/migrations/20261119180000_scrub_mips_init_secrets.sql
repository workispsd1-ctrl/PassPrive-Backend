update public.payment_sessions
set gateway_payload = jsonb_set(
  gateway_payload,
  '{mips_init_response}',
  jsonb_build_object('operation_status', gateway_payload #>> '{mips_init_response,answer,operation_status}')
)
where gateway_payload ? 'mips_init_response'
  and gateway_payload->'mips_init_response' ? 'original_message';
