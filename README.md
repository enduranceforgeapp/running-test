# Endurance Forge Volume

Engine de corrida que usa as regras de `regras/regras_de_controle_de_volume.xlsx`, com as mesmas entradas do formulário da Endurance Forge.

- `volume_engine.js`: a engine (navegador e Node). A planilha está em `SHEET` e `PREREQ`; o que não está na planilha (progressão semanal, recuperação, polimento, escolha dos dias) está em `COMPLEMENT`.
- `index.html`: a página publicada como artifact (carrega `volume_engine.js`).
- `tests/planilha_valores.py`: calcula as fórmulas da planilha e grava `tests/planilha_valores.json`.
- `tests/test_engine.js`: compara a tabela da engine com esses valores e testa as regras do plano.

```sh
python3 -I tests/planilha_valores.py regras/regras_de_controle_de_volume.xlsx   # precisa de openpyxl
node tests/test_engine.js
```
