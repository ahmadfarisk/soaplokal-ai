from optimum.intel import OVModelForCausalLM
from transformers import AutoTokenizer

model_id = "hsuwill000/Qwen2.5-1.5B-Instruct-abliterated-openvino-8bit"

model = OVModelForCausalLM.from_pretrained(model_id, device="AUTO")
tokenizer = AutoTokenizer.from_pretrained(model_id)

messages = [{"role": "user", "content": "Say hi in one sentence."}]
prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

inputs = tokenizer(prompt, return_tensors="pt")
outputs = model.generate(**inputs, max_new_tokens=200)
text = tokenizer.decode(outputs[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)
print(text)