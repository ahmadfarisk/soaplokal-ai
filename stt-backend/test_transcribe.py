
from optimum.intel import OVModelForSpeechSeq2Seq
from transformers import AutoProcessor, pipeline

model_id = "models/whisper-tiny-int8-ov"

model = OVModelForSpeechSeq2Seq.from_pretrained(model_id)
processor = AutoProcessor.from_pretrained(model_id)

pipe = pipeline(
    "automatic-speech-recognition",
    model=model,
    tokenizer=processor.tokenizer,
    feature_extractor=processor.feature_extractor,
)

result = pipe("test_audio.mp3")
print(result["text"])