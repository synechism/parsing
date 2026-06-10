# L40S is Ada Lovelace, which is supported by the vLLM CUDA image used by MinerU.
FROM vllm/vllm-openai:v0.21.0

ENV PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    MINERU_MODEL_SOURCE=local \
    MINERU_DEVICE_MODE=cuda \
    TORCH_CUDNN_V8_API_DISABLED=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        fontconfig \
        fonts-noto-cjk \
        fonts-noto-core \
        libgl1 && \
    fc-cache -fv && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir -U "mineru[core]>=3.2.1"

# Bake model weights into the image so first request does not block on downloads.
RUN mineru-models-download -s huggingface -m all

EXPOSE 8000

CMD ["mineru-api", "--host", "0.0.0.0", "--port", "8000", "--enable-vlm-preload", "true"]

