from transformers import pipeline

pipe = pipeline(
    "automatic-speech-recognition",
    model="whisper-tiny-ov",
    accelerator="openvino",
)

result = pipe("test_audio.wav")
print(result["text"])