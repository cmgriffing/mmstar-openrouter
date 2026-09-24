# MMStar: OpenRouter

This repo is meant to be an implementation of the MMStar benchmarks that is set up in a way to evaluate the capabilities of models via the OpenRouter API.

The end goal is to have a verifiable set of data that can be used to make informed decisions about which models to use for various image understanding using cases and allow for the selection of cheaper or faster models with a good enough level of understanding.

## Development

Workspace documentation:

- [`docs/architecture.md`](./docs/architecture.md) — components, runtime boundaries, and the results/publication model
- [`docs/configuration.md`](./docs/configuration.md) — `mmstar.config.json` fields, reasoning modes, and routing settings
- [`docs/contracts.md`](./docs/contracts.md) — dataset parsing, schema versions, run records, and engine events
- [`docs/development.md`](./docs/development.md) — pinned toolchain, commands, conventions, and the bounded-session workflow
- [`docs/website.md`](./docs/website.md) — query endpoints, per-target build/deploy commands, and verification status
- [`docs/adr/0001-web-sqlite-reader.md`](./docs/adr/0001-web-sqlite-reader.md) — the WASM SQLite reader decision and measured evidence

Quick start:

```bash
pnpm install
pnpm check
pnpm build
```

## License

This implementation and code in this repo (besides the dataset) is licensed under the [MIT License](./LICENSE).

This repo claims no ownership or copyright over the dataset used for benchmarking.
The dataset is sourced from: https://huggingface.co/datasets/Lin-Chen/MMStar

None of the original benchmarking code is reused.
The original benchmark implementation can be found at: https://github.com/MMStar-Benchmark/MMStar

## ✒️ Citation

If you find our work helpful for your research, please consider giving a star ⭐ and citation 📝

```bibtex
@article{chen2024we,
  title={Are We on the Right Way for Evaluating Large Vision-Language Models?},
  author={Chen, Lin and Li, Jinsong and Dong, Xiaoyi and Zhang, Pan and Zang, Yuhang and Chen, Zehui and Duan, Haodong and Wang, Jiaqi and Qiao, Yu and Lin, Dahua and others},
  journal={arXiv preprint arXiv:2403.20330},
  year={2024}
}
```
