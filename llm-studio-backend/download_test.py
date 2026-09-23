from huggingface_hub import hf_hub_download

path = hf_hub_download(
    repo_id="drmcbride/Qwen3-0.6B-Q8_0-GGUF",
    filename="qwen3-0.6b-q8_0.gguf",
    local_dir="./models"
)
print("Downloaded to:", path)