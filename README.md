# Endurance Forge Volume

Engine de corrida que usa as regras de `regras/regras_de_controle_de_volume.xlsx`, com as mesmas entradas do formulário da Endurance Forge.

- `volume_engine.js`: a engine (navegador e Node). A planilha está em `SHEET` e `PREREQ`; o que nenhuma regra define (polimento, escolha dos dias, aquecimento dos tiros) está em `COMPLEMENT`. As regras do treinador (teto dos tiros, mínimo dos contínuos e os modelos de periodização 3:1 e alternado) estão em `COACH`.
- `index.html`: a página publicada como artifact (carrega `volume_engine.js`).
- `tests/planilha_valores.py`: calcula as fórmulas da planilha e grava `tests/planilha_valores.json`.
- `tests/test_engine.js`: compara a tabela da engine com esses valores e testa as regras do plano.

```sh
python3 -I tests/planilha_valores.py regras/regras_de_controle_de_volume.xlsx   # precisa de openpyxl
node tests/test_engine.js
```

## Método

- `metodo/periodizacao.html`: guia de periodização por modalidade e combinações (publicado como artifact).
