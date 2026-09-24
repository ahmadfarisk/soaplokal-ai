from optimum.intel import OVModelForSpeechSeq2Seq
from transformers import AutoProcessor
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "models"


model_id = "OpenVINO/whisper-tiny-int8-ov"

model = OVModelForSpeechSeq2Seq.from_pretrained(model_id)  # no export=True — already converted
processor = AutoProcessor.from_pretrained(model_id)

output_path = MODELS_DIR / "whisper-tiny-int8-ov"

model.save_pretrained(output_path)
processor.save_pretrained(output_path)