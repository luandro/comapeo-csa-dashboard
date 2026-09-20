# Talhões privados

Este diretório recebe os polígonos privados da fazenda usados para gerar o painel. Copie os arquivos a partir do projeto da sua própria fazenda; eles não são baixados do CoMapeo Cloud.

Formato esperado:

- um arquivo por área, com nome `Name_<TALHAO>.geojson`;
- geometria GeoJSON do tipo `Polygon` ou `MultiPolygon`, em longitude/latitude;
- propriedade `properties.Name`, como `A5 SAF`;
- propriedade numérica `properties.area_ha`;
- um arquivo com `properties.Name` igual a `PERIMETRO DO SÍTIO` para o limite externo.

Os arquivos `.geojson` deste diretório contêm localização e desenho reais da propriedade. São dados privados, estão ignorados pelo Git e nunca devem ser enviados ao repositório público. Somente este README pode ser versionado.
