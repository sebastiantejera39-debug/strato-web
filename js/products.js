/* ==========================================================================
   STORGE LAB — datos de catálogo
   Editá este archivo para cargar tus productos reales: nombre, categoría,
   precio, colores disponibles, descripción y fotos.

   Cómo agregar fotos reales:
   - Poné las imágenes en /images/productos/ (creá la carpeta)
   - En cada producto, cambiá "images: []" por, por ejemplo:
     images: ["images/productos/lampara-onda-1.jpg", "images/productos/lampara-onda-2.jpg"]
   - Si "images" queda vacío, la web muestra automáticamente un placeholder
     prolijo en vez de una foto rota.
   ========================================================================== */

const STRATO_CATEGORIES = [
  { slug: "iluminacion", name: "Iluminación", short: "Lámparas y veladores", image: null },
  { slug: "decoracion", name: "Decoración", short: "Floreros y objetos", image: null },
  { slug: "organizacion", name: "Organización", short: "Bandejas y contenedores", image: null },
  { slug: "jardin", name: "Macetas y jardín", short: "Macetas e interior verde", image: null },
  { slug: "personalizados", name: "Personalizados", short: "A pedido, con tu diseño", image: null },
];

const STRATO_PRODUCTS = [
  {
    id: "lamp-onda",
    name: "Lámpara Onda",
    categories: ["iluminacion"],
    price: 1890,
    colors: ["Crudo", "Terracota", "Grafito"],
    material: "PLA multicolor",
    tag: "Destacado",
    description:
      "Lámpara de mesa con capas onduladas que dejan pasar una luz cálida y difusa. Impresa en una sola pieza, sin costuras.",
    images: [],
  },
  {
    id: "velador-storge",
    name: "Velador Storge",
    categories: ["iluminacion"],
    price: 1450,
    colors: ["Crudo", "Piedra"],
    material: "PLA",
    description:
      "Velador compacto de líneas rectas, pensado para mesa de luz. Zócalo E27, cable textil incluido.",
    images: [],
  },
  {
    id: "aplique-capas",
    name: "Aplique Capas",
    categories: ["iluminacion"],
    price: 2200,
    colors: ["Terracota", "Grafito"],
    material: "PLA multicolor",
    tag: "Nuevo",
    description: "Aplique de pared con relieve de capas visibles a propósito: la textura de la impresión como diseño.",
    images: [],
  },
  {
    id: "florero-degrade",
    name: "Florero Degradé",
    categories: ["decoracion"],
    price: 990,
    colors: ["Terracota/Crudo", "Salvia/Crudo"],
    material: "PLA reciclado",
    tag: "Destacado",
    description:
      "Cada pieza sale con un degradé único: al imprimirse en dos tonos, no hay dos floreros iguales. Apto flores naturales con vaso interior.",
    images: [],
  },
  {
    id: "centro-mesa-terrazas",
    name: "Centro de Mesa Terrazas",
    categories: ["decoracion"],
    price: 1350,
    colors: ["Crudo", "Piedra"],
    material: "PLA",
    description: "Bandeja escultórica de niveles, pensada para centro de mesa o vitrina.",
    images: [],
  },
  {
    id: "portarretrato-lineas",
    name: "Portarretrato Líneas",
    categories: ["decoracion"],
    price: 590,
    colors: ["Crudo", "Grafito", "Terracota"],
    material: "PLA",
    description: "Portarretrato 10x15 con marco acanalado. Se apoya sola, sin vidrio.",
    images: [],
  },
  {
    id: "florero-organza",
    name: "Florero Organza",
    categories: ["decoracion"],
    price: 1190,
    colors: ["Traslúcido", "Crudo"],
    material: "PLA silk",
    description: "Pared fina con acabado satinado que juega con la luz, inspirado en textiles livianos.",
    images: [],
  },
  {
    id: "bandeja-modular",
    name: "Bandeja Modular",
    categories: ["organizacion"],
    price: 780,
    colors: ["Crudo", "Piedra", "Grafito"],
    material: "PLA",
    description: "Bandeja de escritorio con divisiones para útiles, cargador y llaves. Apilable.",
    images: [],
  },
  {
    id: "organizador-escritorio",
    name: "Organizador de Escritorio",
    categories: ["organizacion"],
    price: 1050,
    colors: ["Grafito", "Crudo"],
    material: "PLA",
    tag: "Nuevo",
    description: "Tres compartimentos + porta lápices integrado. Base antideslizante.",
    images: [],
  },
  {
    id: "frutero-capas",
    name: "Frutero Capas",
    categories: ["organizacion"],
    price: 1290,
    colors: ["Terracota", "Crudo"],
    material: "PLA multicolor",
    description: "Frutero de dos niveles con estructura calada, liviano y fácil de lavar.",
    images: [],
  },
  {
    id: "maceta-terraza",
    name: "Maceta Terraza",
    categories: ["jardin"],
    price: 690,
    colors: ["Terracota", "Salvia", "Crudo"],
    material: "PLA reciclado",
    tag: "Destacado",
    description: "Maceta con plato integrado y reserva de agua. Disponible en tres tamaños.",
    images: [],
  },
  {
    id: "macetero-colgante",
    name: "Macetero Colgante",
    categories: ["jardin"],
    price: 590,
    colors: ["Crudo", "Piedra"],
    material: "PLA",
    description: "Para plantas colgantes tipo potus. Incluye soporte de cuerda de algodón.",
    images: [],
  },
  {
    id: "set-suculentas",
    name: "Set Suculentas x3",
    categories: ["jardin"],
    price: 990,
    colors: ["Mix Tierra"],
    material: "PLA multicolor",
    description: "Tres macetas mini en tonos tierra, ideales para escritorio o ventana.",
    images: [],
  },
  {
    id: "pieza-personalizada",
    name: "Pieza a Medida",
    categories: ["personalizados"],
    price: null,
    priceLabel: "Cotizar",
    colors: ["A elección"],
    material: "PLA / PETG",
    description:
      "Diseñamos e imprimimos tu idea: logo, repuesto, regalo o pieza funcional. Contanos qué necesitás y te devolvemos un presupuesto.",
    images: [],
  },
  {
    id: "topper-torta",
    name: "Topper Personalizado",
    categories: ["personalizados"],
    price: null,
    priceLabel: "Cotizar",
    colors: ["A elección"],
    material: "PLA",
    description: "Topper de torta o evento con nombre, fecha o diseño a pedido.",
    images: [],
  },
  {
    id: "placa-nombre",
    name: "Placa Nombre para Puerta",
    categories: ["personalizados"],
    price: null,
    priceLabel: "Cotizar",
    colors: ["A elección"],
    material: "PLA",
    description: "Cartel personalizado para puerta, escritorio o vidriera con tipografía a elección.",
    images: [],
  },
];

/* Utilidad para formatear precio en pesos uruguayos */
function stratoFormatPrice(product) {
  if (product.price == null) return product.priceLabel || "Cotizar";
  return "$U " + product.price.toLocaleString("es-UY");
}
