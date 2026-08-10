import os
import time
import unittest

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


BASE_URL = "http://localhost:3000"

EVIDENCIAS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "evidencias"
)

os.makedirs(EVIDENCIAS, exist_ok=True)


class TestRaceSyncF1(unittest.TestCase):

    def setUp(self):
        options = webdriver.ChromeOptions()
        options.add_argument("--start-maximized")

        self.driver = webdriver.Chrome(options=options)
        self.wait = WebDriverWait(self.driver, 15)

        self.driver.get(BASE_URL)

    def tearDown(self):
        self.driver.quit()

    def screenshot(self, nombre):
        ruta = os.path.join(EVIDENCIAS, nombre)
        self.driver.save_screenshot(ruta)
        print(f"Evidencia guardada: {ruta}")

    # ---------------------------------------------------------
    # PRUEBA 1
    # Verificar carga inicial de RaceSync F1
    # ---------------------------------------------------------
    def test_01_carga_aplicacion(self):
        self.assertEqual(
            self.driver.title,
            "RaceSync F1"
        )

        pantalla_inicio = self.wait.until(
            EC.visibility_of_element_located((By.ID, "ts"))
        )

        self.assertTrue(pantalla_inicio.is_displayed())

        texto = pantalla_inicio.text

        self.assertIn("RACESYNC", texto.replace(" ", ""))
        self.assertIn("TOCA PARA INICIAR", texto)

        self.screenshot("01_carga_inicial.png")

        print("PASS - RaceSync F1 cargó correctamente")

    # ---------------------------------------------------------
    # PRUEBA 2
    # Navegación hacia selección de circuito y piloto
    # ---------------------------------------------------------
    def test_02_flujo_seleccion(self):

        boton_inicio = self.wait.until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "#ts .ps")
            )
        )

        boton_inicio.click()

        selector_circuitos = self.wait.until(
            EC.visibility_of_element_located((By.ID, "cs"))
        )

        self.assertTrue(selector_circuitos.is_displayed())

        self.screenshot("02_seleccion_circuito.png")

        # Seleccionar Silverstone
        silverstone = self.wait.until(
            EC.element_to_be_clickable((By.ID, "c0"))
        )

        silverstone.click()

        confirmar = self.wait.until(
            EC.element_to_be_clickable((By.ID, "cgb"))
        )

        self.assertTrue(confirmar.is_enabled())

        confirmar.click()

        seleccion_piloto = self.wait.until(
            EC.visibility_of_element_located((By.ID, "sel"))
        )

        self.assertTrue(seleccion_piloto.is_displayed())

        # Verificar que existe un equipo seleccionado
        equipo = self.wait.until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, "#tg .tc.active")
            )
        )

        self.assertTrue(equipo is not None)

        self.screenshot("03_seleccion_piloto.png")

        print("PASS - Navegación circuito/piloto correcta")

    # ---------------------------------------------------------
    # PRUEBA 3
    # Registrar jugador y comprobar HUD distribuido
    # ---------------------------------------------------------
    def test_03_ingreso_jugador_y_hud(self):

        # Inicio
        self.wait.until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "#ts .ps")
            )
        ).click()

        # Elegir circuito
        self.wait.until(
            EC.element_to_be_clickable((By.ID, "c0"))
        ).click()

        # Confirmar circuito
        self.wait.until(
            EC.element_to_be_clickable((By.ID, "cgb"))
        ).click()

        # Introducir nombre
        nombre = self.wait.until(
            EC.visibility_of_element_located((By.ID, "ni"))
        )

        nombre.clear()
        nombre.send_keys("SeleniumTest")

        self.screenshot("04_piloto_selenium.png")

        # Botón ACELERAR AL GRID
        boton_grid = self.wait.until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "#sel button.gb")
            )
        )

        boton_grid.click()

        # Esperar registro mediante Socket.IO y aparición del HUD
        hud = self.wait.until(
            EC.visibility_of_element_located((By.ID, "hud"))
        )

        self.assertTrue(hud.is_displayed())

        # Verificar elementos principales
        velocidad = self.wait.until(
            EC.presence_of_element_located((By.ID, "spn"))
        )

        vuelta = self.wait.until(
            EC.presence_of_element_located((By.ID, "ln"))
        )

        nodos = self.wait.until(
            EC.presence_of_element_located((By.ID, "nds"))
        )

        reloj_vectorial = self.wait.until(
            EC.presence_of_element_located((By.ID, "vc"))
        )

        self.assertIsNotNone(velocidad)
        self.assertIsNotNone(vuelta)
        self.assertIsNotNone(reloj_vectorial)

        self.assertIn("S1", nodos.text)
        self.assertIn("S2", nodos.text)
        self.assertIn("S3", nodos.text)

        # Esperamos un poco para capturar la interfaz completa
        time.sleep(2)

        self.screenshot("05_hud_distribuido.png")

        print("PASS - Jugador registrado correctamente")
        print("PASS - HUD visible")
        print("PASS - Nodos S1, S2 y S3 visibles")
        print("PASS - Reloj vectorial presente")


if __name__ == "__main__":
    unittest.main(verbosity=2)